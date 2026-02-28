package com.augmentos.augmentos_core.smarterglassesmanager.utils;

import android.util.Base64;

import java.io.UnsupportedEncodingException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

import android.util.Log;

public class AES {
    private static final String TAG = "WearableIntelligenceSystem_AES";

    private static SecretKeySpec secretKey;
    private static byte[] key;

    public static void setKey(String myKey)
    {
        MessageDigest sha = null;
        try {
            key = myKey.getBytes("UTF-8");
            sha = MessageDigest.getInstance("SHA-1");
            key = sha.digest(key);
            key = Arrays.copyOf(key, 16);
            secretKey = new SecretKeySpec(key, "AES");
        }
        catch (NoSuchAlgorithmException e) {
            e.printStackTrace();
        }
        catch (UnsupportedEncodingException e) {
            e.printStackTrace();
        }
    }

    public static String encrypt(String strToEncrypt, String secret)
    {
        try
        {
            setKey(secret);
            Cipher cipher = Cipher.getInstance("AES/ECB/PKCS7Padding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
            return Base64.encodeToString(cipher.doFinal(strToEncrypt.getBytes("UTF-8")), Base64.DEFAULT);
        }
        catch (Exception e)
        {
            Log.d(TAG, "Error while encrypting: " + e.toString());
        }
        return null;
    }

    //bytes version
    public static byte [] encrypt(byte [ ] bytesToEncrypt, String secret)
    {
        try
        {
            setKey(secret);
            Cipher cipher = Cipher.getInstance("AES/ECB/PKCS7Padding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
            return cipher.doFinal(bytesToEncrypt);
        }
        catch (Exception e)
        {
            Log.d(TAG, "Error while encrypting: " + e.toString());
        }
        return null;
    }

    //String version
    public static String decrypt(String strToDecrypt, String secret)
    {
        try
        {
            Log.d(TAG, "Secret key is: " + secret);
            setKey(secret);
            Cipher cipher = Cipher.getInstance("AES/ECB/PKCS7PADDING");
            cipher.init(Cipher.DECRYPT_MODE, secretKey);
            return new String(cipher.doFinal(Base64.decode(strToDecrypt, Base64.DEFAULT)));
        }
        catch (Exception e)
        {
            Log.d(TAG, "Error while decrypting: " + e.toString());
        }
        return null;
    }

    //bytes version
    public static byte [] decrypt(byte [] bytesToDecrypt, String secret)
    {
        try
        {
            setKey(secret);
            Cipher cipher = Cipher.getInstance("AES/ECB/PKCS7PADDING");
            cipher.init(Cipher.DECRYPT_MODE, secretKey);
            return cipher.doFinal(bytesToDecrypt);
        }
        catch (Exception e)
        {
            Log.d(TAG, "Error while decrypting: " + e.toString());
        }
        return null;
    }
}
