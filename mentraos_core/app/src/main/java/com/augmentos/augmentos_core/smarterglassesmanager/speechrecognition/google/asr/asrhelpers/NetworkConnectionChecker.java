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

import static android.net.ConnectivityManager.CONNECTIVITY_ACTION;
import static android.os.Build.VERSION_CODES.N;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.ConnectivityManager.NetworkCallback;
import android.net.Network;
import android.net.NetworkInfo;
import android.os.Build.VERSION;

import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.Observer;

import com.google.audio.NetworkState;
import com.google.common.base.Preconditions;
import com.google.common.flogger.FluentLogger;

/**
 * Checks whether or not there is currently a connection and if that connection is Wifi. Need to
 * call {@link #unregisterNetworkCallback()} before it is destroyed.
 */
public class NetworkConnectionChecker {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();
  private final ConnectivityManager connectionManager;
  private final NetworkCallback networkCallback;
  private final MutableLiveData<NetworkState> state;
  private final Context context;
  private final BroadcastReceiver networkStateReceiver =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          synchronized (state) {
            state.postValue(getNetworkState());
          }
        }
      };

  public NetworkConnectionChecker(Context context) {
    Preconditions.checkNotNull(
        context, "You need to pass a context to the NetworkConnectionChecker");
    this.context = context;
    this.connectionManager =
        (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    this.networkCallback =
        new NetworkCallback() {
          @Override
          public void onAvailable(Network network) {
            synchronized (state) {
              logger.atConfig().log("Network is available.");
              state.postValue(
                  NetworkState.newBuilder()
                      .setConnected(true)
                      .setNetworkMetered(connectionManager.isActiveNetworkMetered())
                      .build());
            }
          }

          @Override
          public void onLost(Network network) {
            synchronized (state) {
              logger.atConfig().log("Network is unavailable.");
              state.postValue(
                  NetworkState.newBuilder()
                      .setConnected(false)
                      .setNetworkMetered(connectionManager.isActiveNetworkMetered())
                      .build());
            }
          }
        };
    state = new MutableLiveData<>();
    registerNetworkCallback();
  }

  public void addNetworkStateObserver(LifecycleOwner owner, Observer<NetworkState> observer) {
    synchronized (state) {
      state.observe(owner, observer);
    }
  }

  protected NetworkState getNetworkState() {
    NetworkInfo activeNetwork = connectionManager.getActiveNetworkInfo();
    boolean isConnected = activeNetwork != null && activeNetwork.isConnectedOrConnecting();
    NetworkState state =
        NetworkState.newBuilder()
            .setConnected(isConnected)
            .setNetworkMetered(connectionManager.isActiveNetworkMetered())
            .build();
    return state;
  }

  public boolean isConnected() {
    synchronized (state) {
      return state.getValue().getConnected();
    }
  }

  /**
   * Applications can skip register if they don't need register/unregister many times. Callback
   * register is done in the constructor.
   */
  public void registerNetworkCallback() {
    synchronized (state) {
      state.postValue(getNetworkState());
    }
    if (VERSION.SDK_INT >= N) {
      connectionManager.registerDefaultNetworkCallback(networkCallback);
    } else {
      context.registerReceiver(networkStateReceiver, new IntentFilter(CONNECTIVITY_ACTION));
    }
  }

  /** Note this must be called if NetworkConnectionChecker is not being used anymore. */
  public void unregisterNetworkCallback() {
    try {
      if (VERSION.SDK_INT >= N) {
        connectionManager.unregisterNetworkCallback(networkCallback);
      } else {
        context.unregisterReceiver(networkStateReceiver);
      }
    } catch (IllegalArgumentException unregisteredCallbackException) {
      logger.atWarning().log("Tried to unregister network callback already unregistered.");
    }
  }
}
