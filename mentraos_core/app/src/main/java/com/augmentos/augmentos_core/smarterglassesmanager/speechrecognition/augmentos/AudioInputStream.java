package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.augmentos;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;

public class AudioInputStream {
    public static final int SAMPLE_RATE = 16000;
    public static final short BITS_PER_SAMPLE = 16;
    public static final short CHANNELS = 1;

    private final BlockingQueue<byte[]> audioQueue;
    private byte[] leftoverChunk;
    private int leftoverOffset;

    private static AudioInputStream instance;

    private AudioInputStream() {
        this.audioQueue = new LinkedBlockingQueue<>();
        this.leftoverChunk = null;
        this.leftoverOffset = 0;
    }

    public static synchronized AudioInputStream getInstance() {
        if (instance == null) {
            instance = new AudioInputStream();
        }
        return instance;
    }

    public void push(byte[] audioChunk) {
        audioQueue.add(audioChunk);
    }

    public byte[] read(int bufferSize) {
        byte[] dataBuffer = new byte[bufferSize];
        int bytesRead = 0;

        try {
            if (leftoverChunk != null) {
                int length = Math.min(leftoverChunk.length - leftoverOffset, bufferSize);
                System.arraycopy(leftoverChunk, leftoverOffset, dataBuffer, 0, length);
                leftoverOffset += length;
                bytesRead = length;

                if (leftoverOffset >= leftoverChunk.length) {
                    leftoverChunk = null;
                    leftoverOffset = 0;
                }
            }

            while (bytesRead < bufferSize) {
                byte[] chunk = audioQueue.take();
                int length = Math.min(chunk.length, bufferSize - bytesRead);
                System.arraycopy(chunk, 0, dataBuffer, bytesRead, length);
                bytesRead += length;

                if (length < chunk.length) {
                    leftoverChunk = chunk;
                    leftoverOffset = length;
                    break;
                }
            }

            if (bytesRead < bufferSize) {
                byte[] trimmedBuffer = new byte[bytesRead];
                System.arraycopy(dataBuffer, 0, trimmedBuffer, 0, bytesRead);
                return trimmedBuffer;
            }

            return dataBuffer;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new byte[0];
        }
    }

    public void close() {
        audioQueue.clear();
    }

    public boolean hasData() {
        return !audioQueue.isEmpty() || leftoverChunk != null;
    }
}