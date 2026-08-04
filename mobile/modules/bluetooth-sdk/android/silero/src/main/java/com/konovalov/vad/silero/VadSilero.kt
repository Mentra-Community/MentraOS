package com.konovalov.vad.silero

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.OrtSession.SessionOptions
import android.content.Context
import com.konovalov.vad.silero.config.FrameSize
import com.konovalov.vad.silero.config.Mode
import com.konovalov.vad.silero.config.SampleRate
import com.konovalov.vad.silero.utils.AudioUtils.getFramesCount
import com.konovalov.vad.silero.utils.AudioUtils.toFloatArray
import com.konovalov.vad.silero.utils.TensorMap
import java.io.Closeable
import java.nio.FloatBuffer
import java.nio.LongBuffer
import kotlin.reflect.safeCast

/**
 * Created by Georgiy Konovalov on 6/1/2023.
 *
 * The Silero VAD algorithm, based on DNN, analyzes the audio signal to determine whether it
 * contains speech or non-speech segments. It offers higher accuracy in differentiating speech from
 * background noise compared to the WebRTC VAD algorithm.
 *
 * The Silero VAD supports the following parameters:
 *
 * Sample Rates:
 *
 *      8000Hz,
 *      16000Hz
 *
 * Frame Sizes (per sample rate):
 *
 *    For 8000Hz: 80, 160, 240
 *    For 16000Hz: 160, 320, 480
 *
 * Mode:
 *
 *    NORMAL,
 *    LOW_BITRATE,
 *    AGGRESSIVE,
 *    VERY_AGGRESSIVE
 *
 * Please note that the VAD class supports these specific combinations of sample
 * rates and frame sizes, and the classifiers determine the aggressiveness of the voice
 * activity detection algorithm.
 *
 * @param context           is required for reading the model file from file system.
 * @param sampleRate        is required for processing audio input.
 * @param frameSize         is required for processing audio input.
 * @param mode              is required for the VAD model.
 * @param speechDurationMs  is minimum duration in milliseconds for speech segments (optional).
 * @param silenceDurationMs is minimum duration in milliseconds for silence segments (optional).
 */
class VadSilero(
    context: Context,
    sampleRate: SampleRate,
    frameSize: FrameSize,
    mode: Mode,
    speechDurationMs: Int = 0,
    silenceDurationMs: Int = 0
) : Closeable {

    /**
     * Valid Sample Rates and Frame Sizes for Silero VAD DNN model.
     */
    var supportedParameters: Map<SampleRate, Set<FrameSize>> = mapOf(
        SampleRate.SAMPLE_RATE_8K to setOf(
            FrameSize.FRAME_SIZE_256,
            FrameSize.FRAME_SIZE_512,
            FrameSize.FRAME_SIZE_768
        ),
        SampleRate.SAMPLE_RATE_16K to setOf(
            FrameSize.FRAME_SIZE_512,
            FrameSize.FRAME_SIZE_1024,
            FrameSize.FRAME_SIZE_1536
        )
    )
        private set

    private val env: OrtEnvironment
    private val session: OrtSession
    private var isInitiated: Boolean = false

    private var h = FloatArray(128)
    private var c = FloatArray(128)

    private var speechFramesCount = 0
    private var silenceFramesCount = 0
    private var maxSpeechFramesCount = 0
    private var maxSilenceFramesCount = 0

    /**
     * Determines if the provided audio data contains speech based on the inference result.
     * The audio data is passed to the model for prediction. The result is obtained and compared
     * with the threshold value to determine if it represents speech.
     *
     * @param audioData audio data to analyze.
     * @return 'true' if speech is detected, 'false' otherwise.
     */
    fun isSpeech(audioData: ShortArray): Boolean {
        return isContinuousSpeech(predict(toFloatArray(audioData)))
    }

    /**
     * Determines if the provided audio data contains speech based on the inference result.
     * The audio data is passed to the model for prediction. The result is obtained and compared
     * with the threshold value to determine if it represents speech.
     * Size of audio chunk for ByteArray should be 2x of Frame size.
     *
     * @param audioData audio data to analyze.
     * @return 'true' if speech is detected, 'false' otherwise.
     */
    fun isSpeech(audioData: ByteArray): Boolean {
        return isContinuousSpeech(predict(toFloatArray(audioData)))
    }

    /**
     * Determines if the provided audio data contains speech based on the inference result.
     * The audio data is passed to the model for prediction. The result is obtained and compared
     * with the threshold value to determine if it represents speech.
     *
     * @param audioData audio data to analyze.
     * @return 'true' if speech is detected, 'false' otherwise.
     */
    fun isSpeech(audioData: FloatArray): Boolean {
        return isContinuousSpeech(predict(audioData))
    }

    /**
     * This method designed to detect long utterances without returning false
     * positive results when user makes pauses between sentences.
     *
     * @param isSpeech predicted frame result.
     * @return 'true' if speech is detected, 'false' otherwise.
     */
    private fun isContinuousSpeech(isSpeech: Boolean): Boolean {
        if (isSpeech) {
            if (speechFramesCount <= maxSpeechFramesCount) speechFramesCount++

            if (speechFramesCount > maxSpeechFramesCount) {
                silenceFramesCount = 0
                return true
            }
        } else {
            if (silenceFramesCount <= maxSilenceFramesCount) silenceFramesCount++

            if (silenceFramesCount > maxSilenceFramesCount) {
                speechFramesCount = 0
                return false
            } else if (speechFramesCount > maxSpeechFramesCount) {
                return true
            }
        }
        return false
    }

    /**
     * Determines if the provided audio data contains speech based on the inference result.
     * The audio data is passed to the model for prediction. The result is extracted and compared
     * with the threshold value to determine if it represents speech.
     *
     * @param audioData audio data to analyze.
     * @return 'true' if speech is detected, 'false' otherwise.
     */
    private fun predict(audioData: FloatArray): Boolean {
        checkState()

        return createInputTensors(audioData).use { tensors ->
            session.run(tensors).use { result ->
                extractResult(result) > threshold()
            }
        }
    }

    /**
     * Retrieves and processes the output tensors to obtain the confidence value.
     * The output tensor contains the confidence value, as well as the updated hidden state (H)
     * and cell state (C) values. The H and C values are flattened and converted to float arrays
     * for further processing.
     *
     * @param result output result of the inference session.
     * @return confidence value.
     */
    private fun extractResult(result: OrtSession.Result): Float {
        val confidence: Array<FloatArray>? = unpack(result, OutputTensors.OUTPUT)

        flattenArray(unpack(result, OutputTensors.CN))?.let { c = it }
        flattenArray(unpack(result, OutputTensors.HN))?.let { h = it }

        return confidence?.getOrNull(0)?.getOrNull(0) ?: 0f
    }

    /**
     * Unpacks the value of the specified tensor from an OrtSession.Result object
     * and attempts to cast it to an array of the specified generic type {@code T}.
     *
     * @param output OrtSession.Result object from which to retrieve the value.
     * @param index  specifying the position from which to retrieve the value.
     * @param <T>    generic type to which the value should be cast.
     * @return array of type {@code T} if the casting is successful,
     *         or {@code null} if an exception occurs
     *         or if the value cannot be cast to the specified type.
     */
    private inline fun <reified T> unpack(output: OrtSession.Result, index: Int): Array<T>? {
        return try {
            Array<T>::class.safeCast(output.get(index).value)
        } catch (e: OrtException) {
            null
        }
    }

    /**
     * Flattens a multi-dimensional array of FloatArrays into a one-dimensional FloatArray.
     *
     * @param array multi-dimensional array to be flattened.
     * @return flattened one-dimensional FloatArray if the input array is not null,
     *         or {@code null} if the input array is null.
     */
    private fun flattenArray(array: Array<Array<FloatArray>>?): FloatArray? {
        return array?.flatten()?.flatMap { it.asIterable() }?.toFloatArray()
    }

    /**
     * Creates and returns a map of input tensors for the given audio data, Sample Rate and Frame Size.
     * The audio data is converted to a float array and wrapped in an OnnxTensor with the
     * corresponding tensor shape. The sample rate, hidden state (H), and cell state (C) tensors
     * are also created and added to the map.
     *
     * @param audioData audio data to analyze.
     * @throws OrtException if there was an error in creating the tensors or getting the OrtEnvironment.
     * @return map of input tensors as a TensorMap<String, OnnxTensor>.
     */
    private fun createInputTensors(audioData: FloatArray): TensorMap<String, OnnxTensor> {
        return TensorMap<String, OnnxTensor>().apply {
            InputTensors.INPUT to OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(audioData),
                longArrayOf(1, frameSize.value.toLong())
            )
            InputTensors.SR to OnnxTensor.createTensor(
                env,
                LongBuffer.wrap(longArrayOf(sampleRate.value.toLong())),
                longArrayOf(1)
            )
            InputTensors.H to OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(h),
                longArrayOf(2, 1, 64)
            )
            InputTensors.C to OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(c),
                longArrayOf(2, 1, 64)
            )
        }
    }

    /**
     * Retrieves the model data as a byte array from silero_vad.onnx.
     *
     * @param context android context.
     * @return model data as a ByteArray.
     */
    private fun getModel(context: Context): ByteArray {
        return context.assets.open("silero_vad.onnx").use { it.readBytes() }
    }

    /**
     * Calculates and returns the threshold value based on the value of detection mode.
     * The threshold value represents the confidence level required for VAD to make proper decision.
     * ex. Mode.VERY_AGGRESSIVE requiring a very high prediction accuracy from the model.
     *
     * @return threshold Float value.
     */
    private fun threshold(): Float = when (mode) {
        Mode.NORMAL -> 0.5f
        Mode.AGGRESSIVE -> 0.8f
        Mode.VERY_AGGRESSIVE -> 0.95f
        else -> 0f
    }

    /**
     * Set, retrieve and validate sample rate for Vad Model.
     *
     * Valid Sample Rates:
     *
     *      8000Hz,
     *      16000Hz
     *
     * @param sampleRate is required for processing audio input.
     * @throws IllegalArgumentException if there was invalid sample rate.
     */
    var sampleRate: SampleRate = sampleRate
        set(sampleRate) {
            require(supportedParameters.containsKey(sampleRate)) {
                "VAD doesn't support Sample Rate:${sampleRate}!"
            }
            field = sampleRate
        }

    /**
     * Set, retrieve and validate frame size for Vad Model.
     *
     * Valid Frame Sizes (per sample rate):
     *
     *      For 8000Hz: 256, 512, 768
     *      For 16000Hz: 512, 1024, 1536
     *
     * @param frameSize is required for processing audio input.
     * @throws IllegalArgumentException if there was invalid frame size.
     */
    var frameSize: FrameSize = frameSize
        set(frameSize) {
            require(supportedParameters[sampleRate]?.contains(frameSize) ?: false) {
                "VAD doesn't support Sample rate:${sampleRate} and Frame Size:${frameSize}!"
            }
            field = frameSize
        }

    /**
     * Set and retrieve detection mode for Vad model.
     *
     * Mode:
     *
     *    NORMAL,
     *    LOW_BITRATE,
     *    AGGRESSIVE,
     *    VERY_AGGRESSIVE
     *
     * @param mode is required for the VAD model.
     */
    var mode: Mode = mode
        set(mode) {
            field = mode
        }

    /**
     * Set, retrieve and validate speechDurationMs for Vad Model.
     * The value of this parameter will define the necessary and sufficient duration of positive
     * results to recognize result as speech. This parameter is optional.
     *
     * Permitted range (0ms >= speechDurationMs <= 300000ms).
     *
     * Parameters used for {@link VadSilero.isSpeech}.
     *
     * @param speechDurationMs speech duration ms.
     * @throws IllegalArgumentException if out of permitted range.
     */
    var speechDurationMs: Int = speechDurationMs
        set(speechDurationMs) {
            require(speechDurationMs in 0..300000) {
                "The parameter 'speechDurationMs' should 0ms >= speechDurationMs <= 300000ms!"
            }

            field = speechDurationMs
            maxSpeechFramesCount = getFramesCount(sampleRate.value, frameSize.value, speechDurationMs)
        }

    /**
     * Set, retrieve and validate silenceDurationMs for Vad Model.
     * The value of this parameter will define the necessary and sufficient duration of
     * negative results to recognize it as silence. This parameter is optional.
     *
     * Permitted range (0ms >= silenceDurationMs <= 300000ms).
     *
     * Parameters used in {@link VadSilero.isSpeech}.
     *
     * @param silenceDurationMs silence duration ms.
     * @throws IllegalArgumentException if out of permitted range.
     */
    var silenceDurationMs: Int = silenceDurationMs
        set(silenceDurationMs) {
            require(silenceDurationMs in 0..300000) {
                "The parameter 'silenceDurationMs' should be 0ms >= silenceDurationMs <= 300000ms!"
            }

            field = silenceDurationMs
            maxSilenceFramesCount = getFramesCount(sampleRate.value, frameSize.value, silenceDurationMs)
        }

    /**
     * Closes the ONNX Session and releases all associated resources.
     * This method should be called when the VAD is no longer needed to free up system resources.
     */
    override fun close() {
        checkState()
        isInitiated = false

        session.close()
        env.close()
    }

    /**
     * Check if VAD session already closed.
     *
     * @throws IllegalArgumentException if session already closed.
     */
    private fun checkState() {
        require(isInitiated) { "You can't use Vad after closing session!" }
    }

    /**
     * Constants representing the input tensor names used during model prediction.
     */
    private object InputTensors {
        const val INPUT = "input"
        const val SR = "sr"
        const val H = "h"
        const val C = "c"
    }

    /**
     * Constants representing the output tensor names used when the model returns a result.
     */
    private object OutputTensors {
        const val OUTPUT = 0
        const val HN = 1
        const val CN = 2
    }

    /**
     * Initializes the ONNIX Runtime by creating a session with the provided
     * model file and session options.
     *
     * @param context is required for accessing the model file.
     * @throws IllegalArgumentException if invalid parameters have been set for the model.
     * @throws OrtException if the model failed to parse, wasn't compatible or caused an error.
     */
    init {
        this.sampleRate = sampleRate
        this.frameSize = frameSize
        this.mode = mode
        this.silenceDurationMs = silenceDurationMs
        this.speechDurationMs = speechDurationMs

        val sessionOptions = SessionOptions().apply {
            setIntraOpNumThreads(1)
            setInterOpNumThreads(1)
            setOptimizationLevel(SessionOptions.OptLevel.ALL_OPT)
        }

        this.env = OrtEnvironment.getEnvironment()
        this.session = env.createSession(getModel(context), sessionOptions)
        this.isInitiated = true
    }
}