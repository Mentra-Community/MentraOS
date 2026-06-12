package com.mentra.asg_client.camera.model;

import android.util.Log;

import com.mentra.asg_client.settings.AsgSettings;

import org.json.JSONObject;

/**
 * Per-request capture tuning from {@code take_photo} JSON. Fields that cannot be honored on the
 * current HAL set {@code *Warning} to {@code "not_implemented"} for {@code captureMetadata}.
 */
public final class PhotoCaptureSettings {

    private static final String TAG = "PhotoCaptureSettings";
    private static final String WARNING_NOT_IMPLEMENTED = "not_implemented";

    public static final PhotoCaptureSettings EMPTY = new PhotoCaptureSettings.Builder().build();

    public final Integer aeExposureDivisor;
    public final Integer isoCap;
    public final Boolean noiseReduction;
    public final Boolean edgeEnhancement;
    public final Boolean mfnr;
    public final Integer ispDigitalGain;
    public final String ispAnalogGain;

    public final String noiseReductionWarning;
    public final String ispDigitalGainWarning;
    public final String ispAnalogGainWarning;

    private PhotoCaptureSettings(Builder builder) {
        aeExposureDivisor = builder.aeExposureDivisor;
        isoCap = builder.isoCap;
        noiseReduction = builder.noiseReduction;
        edgeEnhancement = builder.edgeEnhancement;
        mfnr = builder.mfnr;
        ispDigitalGain = builder.ispDigitalGain;
        ispAnalogGain = builder.ispAnalogGain;
        noiseReductionWarning = builder.noiseReductionWarning;
        ispDigitalGainWarning = builder.ispDigitalGainWarning;
        ispAnalogGainWarning = builder.ispAnalogGainWarning;
    }

    public static PhotoCaptureSettings fromTakePhotoJson(JSONObject data) {
        if (data == null) {
            return EMPTY;
        }
        Builder builder = new Builder();

        if (data.has("aeExposureDivisor") && !data.isNull("aeExposureDivisor")) {
            int divisor = data.optInt("aeExposureDivisor", 0);
            if (divisor > 1) {
                builder.aeExposureDivisor(divisor);
            }
        }
        if (data.has("isoCap") && !data.isNull("isoCap")) {
            int cap = data.optInt("isoCap", 0);
            if (cap > 0) {
                builder.isoCap(cap);
            }
        }
        if (data.has("noiseReduction") && !data.isNull("noiseReduction")) {
            builder.noiseReduction(data.optBoolean("noiseReduction", true));
        }
        if (data.has("edgeEnhancement") && !data.isNull("edgeEnhancement")) {
            builder.edgeEnhancement(data.optBoolean("edgeEnhancement", true));
        }
        if (data.has("mfnr") && !data.isNull("mfnr")) {
            builder.mfnr(data.optBoolean("mfnr", true));
        }
        if (data.has("ispDigitalGain") && !data.isNull("ispDigitalGain")) {
            builder.ispDigitalGain(data.optInt("ispDigitalGain", 0));
        }
        if (data.has("ispAnalogGain") && !data.isNull("ispAnalogGain")) {
            Object raw = data.opt("ispAnalogGain");
            if (raw instanceof Number) {
                builder.ispAnalogGain(String.valueOf(((Number) raw).intValue()));
            } else {
                builder.ispAnalogGain(data.optString("ispAnalogGain", null));
            }
        }

        applyUnimplementedWarnings(builder);
        return builder.build();
    }

    /**
     * Fills per-request fields missing from {@code take_photo} with values previously stored via
     * {@code button_photo_setting}.
     */
    public static PhotoCaptureSettings mergeWithStoredDefaults(
            PhotoCaptureSettings request, AsgSettings stored) {
        if (request == null) {
            return EMPTY;
        }
        if (stored == null) {
            return request;
        }
        Builder builder = new Builder();
        builder.aeExposureDivisor(
                request.aeExposureDivisor != null
                        ? request.aeExposureDivisor
                        : stored.getButtonPhotoAeExposureDivisor());
        builder.isoCap(
                request.isoCap != null ? request.isoCap : stored.getButtonPhotoIsoCap());
        builder.noiseReduction(
                request.noiseReduction != null
                        ? request.noiseReduction
                        : stored.getButtonPhotoNoiseReduction());
        builder.edgeEnhancement(
                request.edgeEnhancement != null
                        ? request.edgeEnhancement
                        : stored.getButtonPhotoEdgeEnhancement());
        builder.mfnr(request.mfnr != null ? request.mfnr : stored.isMfnrEnabled());
        builder.ispDigitalGain(
                request.ispDigitalGain != null
                        ? request.ispDigitalGain
                        : stored.getButtonPhotoIspDigitalGain());
        builder.ispAnalogGain(
                request.ispAnalogGain != null
                        ? request.ispAnalogGain
                        : stored.getButtonPhotoIspAnalogGain());
        applyUnimplementedWarnings(builder);
        return builder.build();
    }

    private static void applyUnimplementedWarnings(Builder builder) {
        if (builder.noiseReduction != null && !builder.noiseReduction) {
            Log.w(TAG, "noiseReduction not implemented, using HIGH_QUALITY");
            builder.noiseReductionWarning(WARNING_NOT_IMPLEMENTED);
        }
        if (builder.ispDigitalGain != null) {
            Log.w(TAG, "ispDigitalGain not implemented (requested " + builder.ispDigitalGain + ")");
            builder.ispDigitalGainWarning(WARNING_NOT_IMPLEMENTED);
        }
        if (builder.ispAnalogGain != null && !builder.ispAnalogGain.isEmpty()) {
            Log.w(TAG, "ispAnalogGain not implemented (requested " + builder.ispAnalogGain + ")");
            builder.ispAnalogGainWarning(WARNING_NOT_IMPLEMENTED);
        }
    }

    public boolean usesScanExposure() {
        return aeExposureDivisor != null && aeExposureDivisor > 1;
    }

    public boolean edgeEnhancementEnabled() {
        return edgeEnhancement == null || edgeEnhancement;
    }

    public boolean mfnrEnabled() {
        return mfnr == null || mfnr;
    }

    /** Single-line summary of resolved capture tuning for logcat. */
    public String describeForLog() {
        StringBuilder sb = new StringBuilder();
        sb.append("aeExposureDivisor=").append(aeExposureDivisor);
        sb.append(", isoCap=").append(isoCap);
        sb.append(", noiseReduction=").append(noiseReduction);
        sb.append(", edgeEnhancement=").append(edgeEnhancement);
        sb.append(", mfnr=").append(mfnr);
        sb.append(", ispDigitalGain=").append(ispDigitalGain);
        sb.append(", ispAnalogGain=").append(ispAnalogGain);
        if (noiseReductionWarning != null) {
            sb.append(", noiseReductionWarning=").append(noiseReductionWarning);
        }
        if (ispDigitalGainWarning != null) {
            sb.append(", ispDigitalGainWarning=").append(ispDigitalGainWarning);
        }
        if (ispAnalogGainWarning != null) {
            sb.append(", ispAnalogGainWarning=").append(ispAnalogGainWarning);
        }
        return sb.toString();
    }

    public void appendWarningsTo(JSONObject target) {
        if (target == null) {
            return;
        }
        try {
            if (noiseReductionWarning != null) {
                target.put("noiseReductionWarning", noiseReductionWarning);
            }
            if (ispDigitalGainWarning != null) {
                target.put("ispDigitalGainWarning", ispDigitalGainWarning);
            }
            if (ispAnalogGainWarning != null) {
                target.put("ispAnalogGainWarning", ispAnalogGainWarning);
            }
            if (aeExposureDivisor != null) {
                target.put("aeExposureDivisor", aeExposureDivisor);
            }
            if (isoCap != null) {
                target.put("isoCap", isoCap);
            }
            if (edgeEnhancement != null) {
                target.put("edgeEnhancement", edgeEnhancement);
            }
            if (mfnr != null) {
                target.put("mfnr", mfnr);
            }
        } catch (Exception ignored) {
            // metadata must never break capture
        }
    }

    public static final class Builder {
        private Integer aeExposureDivisor;
        private Integer isoCap;
        private Boolean noiseReduction;
        private Boolean edgeEnhancement;
        private Boolean mfnr;
        private Integer ispDigitalGain;
        private String ispAnalogGain;
        private String noiseReductionWarning;
        private String ispDigitalGainWarning;
        private String ispAnalogGainWarning;

        public Builder aeExposureDivisor(Integer value) {
            aeExposureDivisor = value;
            return this;
        }

        public Builder isoCap(Integer value) {
            isoCap = value;
            return this;
        }

        public Builder noiseReduction(Boolean value) {
            noiseReduction = value;
            return this;
        }

        public Builder edgeEnhancement(Boolean value) {
            edgeEnhancement = value;
            return this;
        }

        public Builder mfnr(Boolean value) {
            mfnr = value;
            return this;
        }

        public Builder ispDigitalGain(Integer value) {
            ispDigitalGain = value;
            return this;
        }

        public Builder ispAnalogGain(String value) {
            ispAnalogGain = value;
            return this;
        }

        public Builder noiseReductionWarning(String value) {
            noiseReductionWarning = value;
            return this;
        }

        public Builder ispDigitalGainWarning(String value) {
            ispDigitalGainWarning = value;
            return this;
        }

        public Builder ispAnalogGainWarning(String value) {
            ispAnalogGainWarning = value;
            return this;
        }

        public PhotoCaptureSettings build() {
            return new PhotoCaptureSettings(this);
        }
    }
}
