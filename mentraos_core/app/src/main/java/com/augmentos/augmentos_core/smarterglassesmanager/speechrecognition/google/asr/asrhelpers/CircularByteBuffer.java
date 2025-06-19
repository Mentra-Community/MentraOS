/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers;

import com.google.common.flogger.FluentLogger;

import java.util.ArrayList;

/**
 * A storage unit for reading chunks of bytes at a time. Only a single writer may populate
 * data in the CircularByteBuffer, but multiple asynchronous reads are supported as long as the
 * write pointer doesn't overlap with any of the read pointers. If this fails to be true, the output
 * bytes may be corrupted.
 */
public class CircularByteBuffer {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();
  private final byte[] buffer;
  private final int capacity;
  private int writeHead = 0;
  private int cumulativeWritten = 0;
  private final ArrayList<Reader> allReaders = new ArrayList<Reader>();

  /** Reads from a CircularBuffer by maintaining its own position. */
  public static class Reader {
    private final CircularByteBuffer owner;
    private int readHead = 0;
    private long cumulativeRead = 0;

    // Can be used to see if samples were lost prior to most recent read.
    // If so many samples have been written that the write pointer overlaps one of the
    // read pointers, samples will be dropped. This is logged in read(), but you can also,
    // as the caller of read(), check whether samples were lost by checking to see if
    // droppedSamplesWarning is true. For example, the following lines would fail an assertion if
    // data were lost:
    //   reader.read(some_buffer);
    //   assert reader.droppedSamplesWarning;
    // This value is set, but never read, by the CircularByteBuffer or its Readers.
    public boolean droppedSamplesWarning = false;

    /**
     * Read, updating the read pointer. numBytes must be less than buffer capacity.
     * @return true on success.
     */
    public boolean read(byte[] dst, int offset, int numBytes) {
      if (owner.read(this, dst, offset, numBytes)) {
        cumulativeRead += numBytes;
        return true;
      }
      return false;
    }

    public boolean read(byte[] dst) {
      return read(dst, 0, dst.length);
    }

    /**
     * Read, without updating the read pointer. numBytes must be less than buffer capacity.
     * @return true on success.
     */
    public boolean peek(byte[] dst, int offset, int numBytes) {
      return owner.peek(this, dst, offset, numBytes);
    }

    public boolean peek(byte[] dst) {
      return peek(dst, 0, dst.length);
    }

    public void advance(int advanceBy) {
      readHead = (readHead + advanceBy) % owner.getCapacity();
    }

    public int availableBytes() {
      return Math.min(owner.getCapacity(), (int) (owner.getCumulativeWritten() - cumulativeRead));
    }

    private Reader(CircularByteBuffer owner) {
      this.owner = owner;
    }


    private void reset() {
      readHead = 0;
      cumulativeRead = 0;
    }
  }

  public CircularByteBuffer(int capacity) {
    buffer = new byte[capacity];
    this.capacity = capacity;
  }

  /**
   * Get a reader for the circular buffer. You may use several of these independently.
   * You should call this before the first call to write() occurring after construction or
   * calling reset(). Otherwise, you may start reading from somewhere in the middle of the stream.
   */
  public Reader newReader() {
    synchronized (allReaders) {
      Reader reader = new Reader(this);
      allReaders.add(reader);
      return reader;
    }
  }

  /** Copy data from src into the circular buffer. Returns false when bytesToWrite
   *  exceeds capacity.
   */
  public synchronized boolean write(byte[] src, int offset, int bytesToWrite) {
    if (bytesToWrite > capacity) {
      return false;
    }
    if (bytesToWrite == 0) {
      return true;
    }
    if (writeHead + bytesToWrite <= capacity) {
      System.arraycopy(src, offset, buffer, writeHead, bytesToWrite);
    } else {  // Data wraps around buffer edge.
      int entriesBeforeWrap = capacity - writeHead;
      System.arraycopy(src, offset, buffer, writeHead, entriesBeforeWrap);
      System.arraycopy(
          src, offset + entriesBeforeWrap, buffer, 0, bytesToWrite - entriesBeforeWrap);
    }
    writeHead = (writeHead + bytesToWrite) % capacity;
    cumulativeWritten += bytesToWrite;
    return true;
  }

  public boolean write(byte[] src) {
    return write(src, 0, src.length);
  }

  public int getCapacity() {
    return capacity;
  }

  /**
   * Resets the circular buffer and all of the readers that have been issued. The class is reset to
   * its initial state upon construction. Readers that have been issued do not get removed.
   */
  public synchronized void reset() {
    java.util.Arrays.fill(buffer, (byte) 0);
    writeHead = 0;
    cumulativeWritten = 0;
    synchronized (allReaders) {
      for (Reader reader : allReaders) {
        reader.reset();
      }
    }
  }

  /**
   * Read data from the buffer and update the read pointer. If the reader is far
   * enough behind (the write pointer passes the read pointer), samples will be dropped to catch up.
   */
  private boolean read(Reader reader, byte[] dst, int offset, int numBytes) {
    reader.droppedSamplesWarning = false;
    if (cumulativeWritten - reader.cumulativeRead > capacity) {
      logger.atSevere().log("We lost data before this read!");
      // Skip ahead to the very end of the buffer.
      int skipAmount = (int) (cumulativeWritten - reader.cumulativeRead) - numBytes;
      reader.advance(skipAmount);
      reader.cumulativeRead += skipAmount;
      reader.droppedSamplesWarning = true;
    }
    if (peek(reader, dst, offset, numBytes)) {
      reader.advance(numBytes);
      return true;
    }
    return false;
  }

  /**
   * Read data from the buffer without modifying the reader. Note that if the
   * reader is far enough behind, this will return corrupted data.
   */
  private boolean peek(Reader reader, byte[] dst, int offset, int numBytes) {
    int bytesToRead = numBytes;
    if (bytesToRead == 0) {
      return true;
    }
    if (bytesToRead < 0 || bytesToRead > reader.availableBytes()) {
      return false;
    }
    int endOfReadSection = (reader.readHead + bytesToRead) % capacity;
    if (reader.readHead < endOfReadSection) {
      System.arraycopy(buffer, reader.readHead, dst, offset, endOfReadSection - reader.readHead);
    } else {  // Data wraps around buffer edge.
      System.arraycopy(buffer, reader.readHead, dst, offset, capacity - reader.readHead);
      int entriesBeforeWrap = capacity - reader.readHead;
      System.arraycopy(
          buffer, 0, dst, offset + capacity - reader.readHead, bytesToRead - entriesBeforeWrap);
    }
    return true;
  }

  public synchronized long getCumulativeWritten() {
    return cumulativeWritten;
  }
}
