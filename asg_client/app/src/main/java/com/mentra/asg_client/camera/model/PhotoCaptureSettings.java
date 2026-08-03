package com.mentra.asg_client.camera.model;

import android.util.Log;

import com.mentra.asg_client.AsgConstants;
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
    /** Independent ZSL buffering flag for this request; null inherits the global default. */
    public final Boolean zsl;
    /** Independent vendor MFNR flag for this request; null inherits the global default. */
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
        zsl = builder.zsl;
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
        if (data.has("zsl") && !data.isNull("zsl")) {
            builder.zsl(data.optBoolean("zsl", true));
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
     * Resolve a single optional request flag against an optional stored button preset and the
     * global device default.
     */
    public static boolean resolveMergedFlag(
            Boolean requestValue, Boolean storedButtonValue, boolean globalDefault) {
        if (requestValue != null) {
            return requestValue;
        }
        if (storedButtonValue != null) {
            return storedButtonValue;
        }
        return globalDefault;
    }

    /**
     * Merge a remote SDK take_photo request with stored device-level settings.
     *
     * <p>Unlike {@link #mergeWithStoredDefaults(PhotoCaptureSettings, AsgSettings)} this variant
     * does NOT inherit stored button-photo scan presets (aeExposureDivisor, isoCap,
     * edgeEnhancement, etc.). Those presets are for the hardware-button capture path only. Remote
     * app requests use only their explicitly supplied fields; ZSL/MFNR fall back to the global
     * device settings, not to scan-mode button presets.
     */
    public static PhotoCaptureSettings mergeForSdkRequest(
            PhotoCaptureSettings request, AsgSettings stored) {
        if (request == null) {
            return EMPTY;
        }
        if (stored == null) {
            return request;
        }
        Builder builder = new Builder();
        builder.aeExposureDivisor(request.aeExposureDivisor);
        builder.isoCap(request.isoCap);
        builder.noiseReduction(request.noiseReduction);
        builder.edgeEnhancement(request.edgeEnhancement);
        builder.ispDigitalGain(request.ispDigitalGain);
        builder.ispAnalogGain(request.ispAnalogGain);
        builder.zsl(resolveMergedFlag(request.zsl, null, stored.isZslEnabled()));
        builder.mfnr(resolveMergedFlag(request.mfnr, null, stored.isMfnrEnabled()));
        applyUnimplementedWarnings(builder);
        return builder.build();
    }

    /**
     * Merge a button/local capture request with stored button-photo tuning.
     *
     * <p>Physical camera-button photos use stored ZSL/MFNR button overrides when present, then
     * inherit the independent global defaults. Explicit request {@code zsl}/{@code mfnr} win.
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
        builder.zsl(
                resolveMergedFlag(
                        request.zsl, stored.getButtonPhotoZsl(), stored.isZslEnabled()));
        builder.mfnr(
                resolveMergedFlag(
                        request.mfnr, stored.getButtonPhotoMfnr(), stored.isMfnrEnabled()));
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

    public boolean zslEnabled() {
        return Boolean.TRUE.equals(zsl);
    }

    public boolean mfnrEnabled() {
        return Boolean.TRUE.equals(mfnr);
    }

    /**
     * Logs scan/capture tuning keys present on incoming {@code take_photo} JSON. Does not log
     * secrets ({@code authToken}, {@code webhookUrl}).
     */
    public static void logIncomingTakePhotoFields(JSONObject data, String requestId) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
            return;
        }
        if (data == null) {
            Log.i(TAG, "SCAN_PARAMS incoming take_photo requestId=" + requestId + " data=null");
            return;
        }
        Log.i(
                TAG,
                "SCAN_PARAMS incoming take_photo requestId="
                        + requestId
                        + " size="
                        + optFieldSummary(data, "size")
                        + " compress="
                        + optFieldSummary(data, "compress")
                        + " sound="
                        + optFieldSummary(data, "sound")
                        + " mfnr="
                        + optFieldSummary(data, "mfnr")
                        + " zsl="
                        + optFieldSummary(data, "zsl")
                        + " noiseReduction="
                        + optFieldSummary(data, "noiseReduction")
                        + " edgeEnhancement="
                        + optFieldSummary(data, "edgeEnhancement")
                        + " ispDigitalGain="
                        + optFieldSummary(data, "ispDigitalGain")
                        + " ispAnalogGain="
                        + optFieldSummary(data, "ispAnalogGain")
                        + " aeExposureDivisor="
                        + optFieldSummary(data, "aeExposureDivisor")
                        + " isoCap="
                        + optFieldSummary(data, "isoCap")
                        + " exposureTimeNs="
                        + optFieldSummary(data, "exposureTimeNs")
                        + " iso="
                        + optFieldSummary(data, "iso"));
    }

    /** Logs per-field source after merging request JSON with stored {@code button_photo_setting}. */
    public static void logMergeDiagnostics(
            PhotoCaptureSettings fromRequest,
            PhotoCaptureSettings merged,
            AsgSettings stored,
            String requestId) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
            return;
        }
        if (fromRequest == null) {
            fromRequest = EMPTY;
        }
        if (merged == null) {
            merged = EMPTY;
        }
        Log.i(
                TAG,
                "SCAN_PARAMS merged take_photo requestId="
                        + requestId
                        + " aeExposureDivisor="
                        + fieldSource(
                                fromRequest.aeExposureDivisor,
                                stored != null ? stored.getButtonPhotoAeExposureDivisor() : null,
                                merged.aeExposureDivisor)
                        + " isoCap="
                        + fieldSource(
                                fromRequest.isoCap,
                                stored != null ? stored.getButtonPhotoIsoCap() : null,
                                merged.isoCap)
                        + " noiseReduction="
                        + fieldSource(
                                fromRequest.noiseReduction,
                                stored != null ? stored.getButtonPhotoNoiseReduction() : null,
                                merged.noiseReduction)
                        + " edgeEnhancement="
                        + fieldSource(
                                fromRequest.edgeEnhancement,
                                stored != null ? stored.getButtonPhotoEdgeEnhancement() : null,
                                merged.edgeEnhancement)
                        + " mfnr="
                        + fieldSource(
                                fromRequest.mfnr,
                                stored != null ? stored.getButtonPhotoMfnr() : null,
                                merged.mfnr)
                        + " zsl="
                        + fieldSource(
                                fromRequest.zsl,
                                stored != null ? stored.getButtonPhotoZsl() : null,
                                merged.zsl)
                        + " ispDigitalGain="
                        + fieldSource(
                                fromRequest.ispDigitalGain,
                                stored != null ? stored.getButtonPhotoIspDigitalGain() : null,
                                merged.ispDigitalGain)
                        + " ispAnalogGain="
                        + fieldSource(
                                fromRequest.ispAnalogGain,
                                stored != null ? stored.getButtonPhotoIspAnalogGain() : null,
                                merged.ispAnalogGain)
                        + " resolved={"
                        + merged.describeForLog()
                        + "}");
        if (stored != null) {
            Log.i(
                    TAG,
                    "SCAN_PARAMS stored button_photo defaults requestId="
                            + requestId
                            + " zsl="
                            + stored.getButtonPhotoZsl()
                            + " mfnr="
                            + stored.getButtonPhotoMfnr()
                            + " size="
                            + stored.getButtonPhotoSize()
                            + " compress="
                            + stored.getButtonPhotoCompress()
                            + " sound="
                            + stored.getButtonPhotoSound());
        }
    }

    /** Logs effective tuning immediately before HAL still capture is submitted. */
    public static void logAppliedAtCapture(
            String requestId,
            PhotoCaptureSettings settings,
            boolean useManualExposure,
            Long meteredExposureNs,
            Long targetExposureNs,
            Integer resolvedIso,
            boolean globalZsl,
            boolean globalMfnr) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
            return;
        }
        if (settings == null) {
            settings = EMPTY;
        }
        Log.i(
                TAG,
                "SCAN_PARAMS applying at capture requestId="
                        + requestId
                        + " useManualExposure="
                        + useManualExposure
                        + " usesScanExposure="
                        + settings.usesScanExposure()
                        + " aeExposureDivisor="
                        + settings.aeExposureDivisor
                        + " meteredExposureNs="
                        + meteredExposureNs
                        + " targetExposureNs="
                        + targetExposureNs
                        + " isoCap="
                        + settings.isoCap
                        + " resolvedIso="
                        + resolvedIso
                        + " noiseReduction="
                        + settings.noiseReduction
                        + " edgeEnhancement="
                        + settings.edgeEnhancement
                        + " zsl(request="
                        + settings.zsl
                        + ", global="
                        + globalZsl
                        + ", effective="
                        + settings.zslEnabled()
                        + ") mfnr(request="
                        + settings.mfnr
                        + ", global="
                        + globalMfnr
                        + ", effective="
                        + settings.mfnrEnabled()
                        + ") tuning={"
                        + settings.describeForLog()
                        + "}");
    }

    private static String optFieldSummary(JSONObject data, String key) {
        if (!data.has(key) || data.isNull(key)) {
            return "<absent>";
        }
        return String.valueOf(data.opt(key));
    }

    private static String fieldSource(Object requestValue, Object storedValue, Object mergedValue) {
        if (mergedValue == null) {
            return "merged=null";
        }
        String source;
        if (requestValue != null && valuesEqual(requestValue, mergedValue)) {
            source = "REQUEST";
        } else if (storedValue != null && valuesEqual(storedValue, mergedValue)) {
            source = "STORED";
        } else {
            source = "RESOLVED";
        }
        return mergedValue + "(" + source + ")";
    }

    private static boolean valuesEqual(Object a, Object b) {
        if (a instanceof Boolean && b instanceof Boolean) {
            return a.equals(b);
        }
        if (a instanceof Number && b instanceof Number) {
            return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        }
        return a.equals(b);
    }

    /** Single-line summary of resolved capture tuning for logcat. */
    public String describeForLog() {
        StringBuilder sb = new StringBuilder();
        sb.append("aeExposureDivisor=").append(aeExposureDivisor);
        sb.append(", isoCap=").append(isoCap);
        sb.append(", noiseReduction=").append(noiseReduction);
        sb.append(", edgeEnhancement=").append(edgeEnhancement);
        sb.append(", zsl=").append(zsl);
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
            if (zsl != null) {
                target.put("zsl", zsl);
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
        private Boolean zsl;
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

        public Builder zsl(Boolean value) {
            zsl = value;
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
