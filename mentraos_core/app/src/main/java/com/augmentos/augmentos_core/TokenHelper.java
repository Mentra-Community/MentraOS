package com.augmentos.augmentos_core;

import android.util.Log;

import androidx.annotation.NonNull;

import com.google.android.gms.tasks.OnCompleteListener;
import com.google.android.gms.tasks.Task;
//import com.google.firebase.auth.FirebaseAuth;
//import com.google.firebase.auth.FirebaseUser;
//import com.google.firebase.auth.GetTokenResult;

import org.json.JSONException;

public class TokenHelper {

    private static String cachedToken = null;
    private static final String TAG = "TokenHelper";
    private static long tokenExpirationTime = 0;

    public interface TokenListener {
        void onTokenReceived(String token) throws JSONException;
        void onTokenFailed(Exception exception);
    }

    public static void getToken(TokenListener listener) throws JSONException {
//        // Set a buffer time of 5 minutes before expiration
//        long bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
//        long currentTime = System.currentTimeMillis();
//
////        Log.d(TAG, "Current Time: " + currentTime);
////        Log.d(TAG, "Token Expiration Time: " + tokenExpirationTime);
////        Log.d(TAG, "Time Left: " + (tokenExpirationTime - currentTime));
//
//        if (cachedToken != null && (currentTime + bufferTime) < tokenExpirationTime) {
////            Log.d(TAG, "Using cached token.");
//            listener.onTokenReceived(cachedToken);
//        } else {
//            Log.d(TAG, "Fetching new token.");
//            FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
//            if (user != null) {
//                user.getIdToken(true).addOnCompleteListener(new OnCompleteListener<GetTokenResult>() {
//                    @Override
//                    public void onComplete(@NonNull Task<GetTokenResult> task) {
//                        if (task.isSuccessful()) {
//                            String idToken = task.getResult().getToken();
//                            cachedToken = idToken;
//                            tokenExpirationTime = (task.getResult().getExpirationTimestamp() * 1000);
//                            Log.d(TAG, "New Token: " + cachedToken);
//                            Log.d(TAG, "New Token Expiration Time: " + tokenExpirationTime);
//                            try {
//                                listener.onTokenReceived(idToken);
//                            } catch (JSONException e) {
//                                throw new RuntimeException(e);
//                            }
//                        } else {
//                            Log.e(TAG, "Failed to get new token.", task.getException());
//                            listener.onTokenFailed(task.getException());
//                        }
//                    }
//                });
//            } else {
//                Log.e(TAG, "User not authenticated.");
//                listener.onTokenFailed(new Exception("User not authenticated"));
//            }
//        }
    }
}
