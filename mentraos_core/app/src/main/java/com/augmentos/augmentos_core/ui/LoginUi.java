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
package com.augmentos.augmentos_core.ui;
import static android.app.Activity.RESULT_OK;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.activity.result.ActivityResultLauncher;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.google.android.gms.tasks.OnCompleteListener;
import com.google.android.gms.tasks.Task;
//import com.google.firebase.auth.FirebaseAuth;
//import com.google.firebase.auth.FirebaseUser;
//import com.google.firebase.auth.GetTokenResult;
import androidx.activity.result.ActivityResultCallback;
import androidx.fragment.app.Fragment;
import androidx.navigation.NavController;
import androidx.navigation.NavOptions;
import androidx.navigation.Navigation;

//import com.firebase.ui.auth.AuthUI;
//import com.firebase.ui.auth.FirebaseAuthUIActivityResultContract;
//import com.firebase.ui.auth.IdpResponse;
//import com.firebase.ui.auth.data.model.FirebaseAuthUIAuthenticationResult;
//import com.google.firebase.auth.ActionCodeSettings;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import com.augmentos.augmentos_core.PermissionsActivity;
import com.augmentos.augmentos_core.R;


public class LoginUi extends Fragment {
  public final String TAG = "AugmentOS_LoginActivity";
  private NavController navController;
  // [START auth_fui_create_launcher]
  // See: https://developer.android.com/training/basics/intents/result
//  private final ActivityResultLauncher<Intent> signInLauncher = registerForActivityResult(
//          new FirebaseAuthUIActivityResultContract(),
//          new ActivityResultCallback<FirebaseAuthUIAuthenticationResult>() {
//            @Override
//            public void onActivityResult(FirebaseAuthUIAuthenticationResult result) {
//              onSignInResult(result);
//            }
//          }
//  );

  public LoginUi(){}

  @Override
  public View onCreateView(LayoutInflater inflater, ViewGroup container,
                           Bundle savedInstanceState) {
    // Inflate the layout for this fragment
    return inflater.inflate(R.layout.landing_fragment, container, false);
  }

  @Override
  public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    navController = Navigation.findNavController(getActivity(), R.id.nav_host_fragment);
    //createSignInIntent();
  }

//  @Override
//  protected void onCreate(Bundle savedInstanceState) {
//    super.onCreate(savedInstanceState);
//    setContentView(R.layout.activity_login);
//    createSignInIntent();
//  }

//  public void createSignInIntent() {
//    // Choose authentication providers
//    List<AuthUI.IdpConfig> providers = Arrays.asList(
//            //new AuthUI.IdpConfig.EmailBuilder().build(),
//            //new AuthUI.IdpConfig.PhoneBuilder().build(),
//            new AuthUI.IdpConfig.GoogleBuilder().build());
//
//    // Create and launch sign-in intent
//    Intent signInIntent = AuthUI.getInstance()
//            .createSignInIntentBuilder()
//            .setAvailableProviders(providers)
//            .build();
//    signInLauncher.launch(signInIntent);
//  }

//  private void onSignInResult(FirebaseAuthUIAuthenticationResult result) {
//    IdpResponse response = result.getIdpResponse();
//    if (result.getResultCode() == RESULT_OK) {
//      // Successfully signed in
//      FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
//
//      // Get the auth token
//      if (user != null) {
//        user.getIdToken(true)
//                .addOnCompleteListener(new OnCompleteListener<GetTokenResult>() {
//                  public void onComplete(@NonNull Task<GetTokenResult> task) {
//                    if (task.isSuccessful()) {
//                      String idToken = task.getResult().getToken();
//                      // Use the idToken for your app logic
//                      Log.d(TAG, "Auth Token: " + idToken);
//                      navigateToMainActivityForSuccess();
//                    } else {
//                      // Handle error -> task.getException();
//                      restartLoginActivity();
//                    }
//                  }
//                });
//      }
//    } else {
//      // Sign in failed. If response is null the user canceled the
//      // sign-in flow using the back button. Otherwise check
//      // response.getError().getErrorCode() and handle the error.
//
//      restartLoginActivity();
//
//    }
//  }
//  public void signOut() {
//    AuthUI.getInstance()
//            .signOut(getActivity())
//            .addOnCompleteListener(new OnCompleteListener<Void>() {
//              public void onComplete(@NonNull Task<Void> task) {
//                Log.d(TAG, "LOGGED OUT");
//
//                // TODO: Evaluate if this is reasonable
//                killApp();
//              }
//            });
//  }
//
//  public void delete() {
//    AuthUI.getInstance()
//            .delete(getActivity())
//            .addOnCompleteListener(new OnCompleteListener<Void>() {
//              @Override
//              public void onComplete(@NonNull Task<Void> task) {
//                Log.d(TAG, "AUTH DELETE");
//
//                // TODO: Evaluate if this is reasonable
//                killApp();
//              }
//            });
//  }
//
//  public void themeAndLogo() {
//    List<AuthUI.IdpConfig> providers = Collections.emptyList();
//
//    // [START auth_fui_theme_logo]
//    Intent signInIntent = AuthUI.getInstance()
//            .createSignInIntentBuilder()
//            .setAvailableProviders(providers)
//            .setLogo(com.augmentos.smartglassesmanager.R.drawable.elon)      // Set logo drawable
//            .setTheme(R.style.AppTheme)      // Set theme
//            .build();
//    signInLauncher.launch(signInIntent);
//    // [END auth_fui_theme_logo]
//  }
//
//  public void privacyAndTerms() {
//    List<AuthUI.IdpConfig> providers = Collections.emptyList();
//
//    // [START auth_fui_pp_tos]
//    Intent signInIntent = AuthUI.getInstance()
//            .createSignInIntentBuilder()
//            .setAvailableProviders(providers)
//            .setTosAndPrivacyPolicyUrls(
//                    "https://teamopensmartglasses.com/terms.html",
//                    "https://teamopensmartglasses.com/privacy.html")
//            .build();
//    signInLauncher.launch(signInIntent);
//    // [END auth_fui_pp_tos]
//  }
//
//  public void emailLink() {
//    // [START auth_fui_email_link]
//    ActionCodeSettings actionCodeSettings = ActionCodeSettings.newBuilder()
//            .setAndroidPackageName(
//                    /* yourPackageName= */ "...",
//                    /* installIfNotAvailable= */ true,
//                    /* minimumVersion= */ null)
//            .setHandleCodeInApp(true) // This must be set to true
//            .setUrl("https://google.com") // This URL needs to be whitelisted
//            .build();
//
//    List<AuthUI.IdpConfig> providers = Arrays.asList(
//            new AuthUI.IdpConfig.EmailBuilder()
//                    .enableEmailLinkSignIn()
//                    .setActionCodeSettings(actionCodeSettings)
//                    .build()
//    );
//    Intent signInIntent = AuthUI.getInstance()
//            .createSignInIntentBuilder()
//            .setAvailableProviders(providers)
//            .build();
//    signInLauncher.launch(signInIntent);
//    // [END auth_fui_email_link]
//  }
////
////  public void catchEmailLink() {
////    List<AuthUI.IdpConfig> providers = Collections.emptyList();
////
////    // [START auth_fui_email_link_catch]
////    if (AuthUI.canHandleIntent(getIntent())) {
////      if (getIntent().getExtras() == null) {
////        return;
////      }
////      String link = getIntent().getExtras().getString("email_link_sign_in");
////      if (link != null) {
////        Intent signInIntent = AuthUI.getInstance()
////                .createSignInIntentBuilder()
////                .setEmailLink(link)
////                .setAvailableProviders(providers)
////                .build();
////        signInLauncher.launch(signInIntent);
////      }
////    }
////    // [END auth_fui_email_link_catch]
////  }

  public void restartLoginActivity(){
    // Restart the LoginActivity
    int id = navController.getCurrentDestination().getId();
    navController.popBackStack(id, true);
    navController.navigate(id);
  }

  public void navigateToMainActivityForSuccess(){
    NavOptions navOptions = new NavOptions.Builder()
            .setPopUpTo(R.id.nav_landing, true) // Replace 'nav_graph_start_destination' with the ID of your start destination in the nav graph
            .build();
    // BOUNCE TO PERMISSIONS ACTIVITY
    Intent intent = new Intent(getContext(), PermissionsActivity.class);
    startActivity(intent);

    // Optionally, finish the current activity if you don't want the user to go back here
    if (getActivity() != null) {
      getActivity().finish();
    }
    // TODO: Put permission check here :)
  }

  public void killApp(){
    //getActivity()stopService(new Intent(getActivity(), AugmentOSService.class));
    //finishAffinity(getActivity());
    System.exit(0);
  }
}
