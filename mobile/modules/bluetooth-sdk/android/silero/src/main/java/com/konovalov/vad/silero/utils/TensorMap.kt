package com.konovalov.vad.silero.utils

import ai.onnxruntime.OnnxTensorLike
import java.io.Closeable

/**
 * Created by Georgiy Konovalov on 1/25/2025.
 *
 * TensorMap is a utility class designed to manage a collection of tensors while
 * ensuring proper resource cleanup. It extends `HashMap` to provide standard
 * map functionality and implements `Closeable` to handle the lifecycle of
 * the tensors within the map.
 *
 * This class is particularly useful in scenarios where tensors need to be
 * systematically organized and safely closed to avoid resource leaks.
 *
 * @param K the type of keys in the map, representing identifiers for the tensors.
 * @param V the type of tensor values in the map, restricted to `OnnxTensorLike` implementations.
 */
class TensorMap<K, V : OnnxTensorLike> : LinkedHashMap<K, V>(), Closeable {

    /**
     * Infix function that allows for a more natural syntax when adding entries to the map.
     * Instead of using put() or map[key] = value, you can write: key to tensor
     *
     * @param tensor The OnnxTensor to associate with the key
     * @return The tensor that was just added
     */
    infix fun K.to(tensor: V): V {
        this@TensorMap[this] = tensor
        return tensor
    }

    /**
     * Releases resources associated with all tensors in the map.
     * Iterates through the map's values and calls the `close` method on each tensor.
     */
    override fun close() {
        values.forEach { it.close() }
    }
}
