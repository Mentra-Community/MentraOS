package com.mentra.core.utils.audio;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.os.AsyncTask;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import com.mentra.lc3Lib.Lc3Cpp;
import com.mentra.core.utils.audio.ByteUtilAudioPlayer;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;

public class Lc3Player extends Thread{
    private Context mContext;
    private AudioTrack mTrack;
    private volatile boolean isPlaying = false;
    private int bufferSize;
    private final int mSampleRate = 16000 ; // 44100;
//    private int mChannelConfig  = AudioFormat.CHANNEL_CONFIGURATION_MONO;
    private int mChannelConfig = AudioFormat.CHANNEL_OUT_MONO;
    //private int mChannelConfig = AudioFormat.CHANNEL_OUT_STEREO;
    private int mChannelRecordConfig = AudioFormat.CHANNEL_IN_MONO;
    private final int mEncoding = AudioFormat.ENCODING_PCM_16BIT;
    private long mDecorderHandle = -1;
    private ArrayBlockingQueue<byte[]> mQueue;
    private int mFrameSize; // LC3 frame size for this player instance
    
    // Rolling audio recording - saves last 20 seconds every 20 seconds
    private static final int ROLLING_DURATION_SECONDS = 20;
    private static final int ROLLING_BUFFER_SIZE = 16000 * 2 * ROLLING_DURATION_SECONDS; // 16kHz * 2 bytes * 20 sec = 640KB
    private byte[] rollingBuffer = new byte[ROLLING_BUFFER_SIZE];
    private int rollingBufferPosition = 0;
    private boolean rollingRecordingEnabled = false;
    private Handler rollingHandler = new Handler(Looper.getMainLooper());
    private Runnable rollingSaveRunnable;
    private int rollingFileCounter = 0;
    private long lastRollingSaveTime = 0;

    public Lc3Player(Context context, int frameSize)
    {
        mContext = context;
        mFrameSize = frameSize;
        mQueue = new ArrayBlockingQueue(100);
    }

    // Backward compatibility constructor (defaults to 40-byte frames for 16kbps, mono, 10ms)
    public Lc3Player(Context context)
    {
        this(context, 40);
    }

    public void init()
    {
        if(mTrack != null)
            return;
        bufferSize = AudioTrack.getMinBufferSize(mSampleRate, mChannelConfig, mEncoding)*4;
        Log.e("_test_", "lc3 bufferSize="+bufferSize);
        mTrack = new AudioTrack(AudioManager.STREAM_MUSIC, mSampleRate, mChannelConfig, mEncoding, bufferSize, AudioTrack.MODE_STREAM);
//        mTrack.setStereoVolume(0.8f,0.8f);
        mTrack.setVolume(1.0f);
        mTrack.setPlaybackRate(mSampleRate);
        mDecorderHandle = Lc3Cpp.initDecoder();
        Log.e("_test_", "lc3 decoder handle="+mDecorderHandle);
    }

    public void startPlay()
    {
        isPlaying = true;
        this.start();
        if(mTrack != null)
        {
            mTrack.play();
        }
        // startRec(); // Recording disabled
    }

    private byte[] mRecvBuffer = new byte[200*10];  // 5 frames × 40 bytes = 200
    private byte[]mBuffer = new byte[200];          // 5 frames × 40 bytes = 200
    private byte[]mTestBuffer = new byte[40];       // Single frame buffer (40 bytes)
    public void write(byte[] data, int offset, int size)
    {
        // if(size != 102)  // 20 bytes × 5 frames + 2 header bytes
        //     return;
        if(!mQueue.offer(data))
        {
            Log.e("_test_","+++++++++ addFrame fail");
        }
    }
    public void write1(byte[] data, int offset, int size)
    {
        if(size != 202)  // 40 bytes × 5 frames + 2 header bytes
            return;
        for(int i = 0;i < 5; i++)
        {
            System.arraycopy(data, i*40 + 2, mTestBuffer, 0, 40);
            byte []decData = Lc3Cpp.decodeLC3(mDecorderHandle, mTestBuffer, mFrameSize);
            if(decData != null)
                mTrack.write(decData, 0, decData.length);
        }
    }
    public void write2(byte[] data, int offset, int size)
    {
        if(size != 202)  // 40 bytes × 5 frames + 2 header bytes
            return;
        System.arraycopy(data, 2, mBuffer, 0, 200);  // Copy 200 bytes (5 × 40)
        byte []decData = Lc3Cpp.decodeLC3(mDecorderHandle, mBuffer, mFrameSize);
        if(decData == null)
        {
            Log.e("_test_", "lc3 decoder data null");
            return;
        }
        Log.e("_test_", "lc3 decoder data seq="+ ByteUtilAudioPlayer.bytetoHexString(data[1])+",size="+decData.length+",ori size="+size);
        mTrack.write(decData, 0, decData.length);
    }
    public void stopPlay()
    {
        isPlaying = false;
        interrupt(); // Properly interrupt the thread

        // Wait for thread to finish before cleaning up resources
        try {
            join(1000); // Wait up to 1 second for thread to terminate
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        synchronized (this) {
            if(mTrack != null)
            {
                try {
                    mTrack.stop();
                    mTrack.release();
                } catch (Exception e) {
                    Log.e("_test_", "Error stopping AudioTrack", e);
                } finally {
                    mTrack = null;
                }
                Lc3Cpp.freeDecoder(mDecorderHandle);
            }
        }
        // stopRec(); // Recording disabled
    }
    private int mLastSeq = 0;
    @Override
    public void run() {
        try {
            setPriority(Thread.MAX_PRIORITY);
            while (isPlaying && !Thread.currentThread().isInterrupted())
            {
                //Log.e(AvConst.TAG, "DealThread mbStartPlay="+mbStartPlay);
                byte[] data = mQueue.take();
                if(data != null && isPlaying)
                {
                    if(false)
                    {
                        for(int i = 0;i < 5; i++)
                        {
                            System.arraycopy(data, i*40 + 2, mTestBuffer, 0, 40);
                            byte []decData = Lc3Cpp.decodeLC3(mDecorderHandle, mTestBuffer, mFrameSize);
                            if(decData != null) {
                                addToRollingBuffer(decData);

                                // Audio playback disabled - uncomment to play through phone speakers
                                /*
                                synchronized (this) {
                                    if (mTrack != null && isPlaying) {
                                        try {
                                            mTrack.write(decData, 0, decData.length);
                                        } catch (IllegalStateException e) {
                                            Log.e("_test_", "AudioTrack write failed - track released", e);
                                            break;
                                        }
                                    }
                                }
                                */
                            }
                        }
                    }
                    else
                    {
                        System.arraycopy(data, 2, mBuffer, 0, 200);  // Copy 200 bytes (5 × 40)
                        if(ByteUtilAudioPlayer.byte2Int(data[1]) != mLastSeq)
                        {
                            Log.e("_test_", "seq error,should be=0x"+ ByteUtilAudioPlayer.intToHexString(mLastSeq, 2)+",but seq="+ByteUtilAudioPlayer.bytetoHexString(data[1]));
                        }
                        else
                        {
                            //Log.i("_test_", "seq ok,seq=0x"+ByteUtilAudioPlayer.bytetoHexString(data[1]));
                        }
                        mLastSeq = ByteUtilAudioPlayer.byte2Int(data[1]);
                        mLastSeq = (mLastSeq + 1) % 256;
                        byte []decData = Lc3Cpp.decodeLC3(mDecorderHandle, mBuffer, mFrameSize);
                        if(decData != null) {
                            // Add to rolling buffer for periodic saving
                            addToRollingBuffer(decData);
                            
                            // Audio playback disabled - uncomment to play through phone speakers
                            synchronized (this) {
                                if (mTrack != null && isPlaying) {
                                    try {
                                        mTrack.write(decData, 0, decData.length);
                                        //Log.e("_test_", "dec="+ByteUtilAudioPlayer.outputHexString(decData, 1440, 160));
                                        //writeRecData(decData, 0, decData.length);
                                    } catch (IllegalStateException e) {
                                        Log.e("_test_", "AudioTrack write failed - track released", e);
                                        break;
                                    }
                                }
                            }
                        }
                    }

                }
            }
        } catch (InterruptedException e) {
            Log.d("_test_", "LC3Player thread interrupted - shutting down gracefully");
            Thread.currentThread().interrupt(); // Preserve interrupt status
        }
        finally {
            mQueue.clear();
            Log.d("_test_", "LC3Player thread finished");
        }
    }
    
    /**
     * Enable rolling audio recording - saves last 20 seconds as M4A file every 20 seconds
     */
    public void enableRollingRecording(boolean enable) {
        rollingRecordingEnabled = enable;
        if (enable) {
            Log.d("_test_", "Rolling audio recording ENABLED - will save 20-second files");
            lastRollingSaveTime = System.currentTimeMillis();
        } else {
            Log.d("_test_", "Rolling audio recording DISABLED");
            rollingHandler.removeCallbacks(rollingSaveRunnable);
        }
    }
    
    /**
     * Add PCM data to the rolling buffer (circular buffer)
     */
    private void addToRollingBuffer(byte[] pcmData) {
        if (!rollingRecordingEnabled || pcmData == null) return;
        
        for (int i = 0; i < pcmData.length; i++) {
            rollingBuffer[rollingBufferPosition] = pcmData[i];
            rollingBufferPosition = (rollingBufferPosition + 1) % ROLLING_BUFFER_SIZE;
        }
        
        // Check if 20 seconds have passed
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastRollingSaveTime >= ROLLING_DURATION_SECONDS * 1000) {
            saveRollingBuffer();
            lastRollingSaveTime = currentTime;
        }
    }
    
    /**
     * Save the rolling buffer as an M4A file
     */
    private void saveRollingBuffer() {
        new Thread(() -> {
            try {
                SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US);
                String timestamp = sdf.format(new Date());
                String filename = "rolling_audio_" + timestamp + ".m4a";
                
                File outputDir = new File(mContext.getExternalFilesDir(null), "rolling_recordings");
                if (!outputDir.exists()) {
                    outputDir.mkdirs();
                }
                File outputFile = new File(outputDir, filename);
                
                // Encode PCM to AAC and save as M4A
                encodePcmToM4a(rollingBuffer, outputFile.getAbsolutePath());
                
                rollingFileCounter++;
                Log.d("_test_", "Saved rolling audio #" + rollingFileCounter + ": " + outputFile.getAbsolutePath());
                
            } catch (Exception e) {
                Log.e("_test_", "Error saving rolling audio", e);
            }
        }).start();
    }
    
    /**
     * Encode PCM data to M4A (AAC) format
     */
    private void encodePcmToM4a(byte[] pcmData, String outputPath) throws IOException {
        MediaCodec encoder = null;
        MediaMuxer muxer = null;
        
        try {
            // Setup AAC encoder
            MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, mSampleRate, 1);
            format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            format.setInteger(MediaFormat.KEY_BIT_RATE, 64000);
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
            
            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            encoder.start();
            
            // Setup muxer
            muxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            
            boolean muxerStarted = false;
            int trackIndex = -1;
            
            // Encode PCM to AAC
            ByteBuffer[] inputBuffers = encoder.getInputBuffers();
            ByteBuffer[] outputBuffers = encoder.getOutputBuffers();
            MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
            
            boolean done = false;
            int inputOffset = 0;
            
            while (!done) {
                // Feed input
                if (inputOffset < pcmData.length) {
                    int inputIndex = encoder.dequeueInputBuffer(10000);
                    if (inputIndex >= 0) {
                        ByteBuffer inputBuffer = inputBuffers[inputIndex];
                        inputBuffer.clear();
                        
                        int chunkSize = Math.min(inputBuffer.remaining(), pcmData.length - inputOffset);
                        inputBuffer.put(pcmData, inputOffset, chunkSize);
                        
                        encoder.queueInputBuffer(inputIndex, 0, chunkSize, 0, 0);
                        inputOffset += chunkSize;
                    }
                } else {
                    int inputIndex = encoder.dequeueInputBuffer(10000);
                    if (inputIndex >= 0) {
                        encoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    }
                }
                
                // Get output
                int outputIndex = encoder.dequeueOutputBuffer(bufferInfo, 10000);
                
                if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat newFormat = encoder.getOutputFormat();
                    trackIndex = muxer.addTrack(newFormat);
                    muxer.start();
                    muxerStarted = true;
                } else if (outputIndex >= 0) {
                    ByteBuffer outputBuffer = outputBuffers[outputIndex];
                    
                    if ((bufferInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && bufferInfo.size != 0 && muxerStarted) {
                        muxer.writeSampleData(trackIndex, outputBuffer, bufferInfo);
                    }
                    
                    encoder.releaseOutputBuffer(outputIndex, false);
                    
                    if ((bufferInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        done = true;
                    }
                }
            }
            
        } finally {
            if (encoder != null) {
                encoder.stop();
                encoder.release();
            }
            if (muxer != null) {
                muxer.stop();
                muxer.release();
            }
        }
    }



//////////////////////
    // Recording functionality disabled - commented out
    /*
    private float mWave = 0;
    private boolean mIsRecording = false;
    private static String FILE_PATH = Environment.getExternalStorageDirectory().toString()+"/1111.pcm";
    private FileOutputStream mFos = null;

    private void startRec(){
        mIsRecording = true;
        mWave = 0;
        try {
            mFos = new FileOutputStream(FILE_PATH);
        } catch (FileNotFoundException e) {
        }
    }
    private void writeRecData(byte[]data, int offset, int len)
    {
        if(len == 0){
            return;
        }
        for(int i = 0; i < len; i++){
            mWave += data[i] * data[i];
        }
        if(mFos != null) {
            try {
                mFos.write(data);
                mWave = mWave / (float)len;
            } catch (IOException e) {
            }
        }
    }
    private void stopRec()
    {
        mIsRecording = false;
        if(mFos != null)
        {
            try {
                mFos.close();
            } catch (IOException e) {
            }
            mFos = null;
        }
    }
    */
}
