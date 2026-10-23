#include <jni.h>
#include <android/log.h>
#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <string.h>

#define LOG_TAG "MentraGStreamer"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

typedef struct _ReceiverData {
    jobject app;
    GstElement *pipeline;
    GstElement *app_sink;
    GstBus *bus;
    GThread *bus_thread;
    GMutex lock;
    gboolean bus_thread_stop;
    guint rendered_frames;
} ReceiverData;

static JavaVM *java_vm = NULL;
static jfieldID native_custom_data_field_id = NULL;
static jmethodID on_native_status_method_id = NULL;
static jmethodID on_native_frame_method_id = NULL;

static ReceiverData *get_receiver_data(JNIEnv *env, jobject thiz);
static void set_receiver_data(JNIEnv *env, jobject thiz, ReceiverData *data);
static void post_status(ReceiverData *data, const char *message);
static void post_frame(ReceiverData *data, gint width, gint height, gint stride, const guint8 *bytes, gsize size);
static void prefer_software_h264_decoder(void);
static gboolean set_string_array_property(GObject *object, const gchar *property, const gchar *value);
static GstElement *on_request_encoded_filter(GstElement *source,
                                             const gchar *producer_id,
                                             const gchar *pad_name,
                                             GstCaps *allowed_caps,
                                             gpointer user_data);
static GstFlowReturn on_new_video_sample(GstAppSink *appsink, gpointer user_data);
static gpointer bus_thread_func(gpointer user_data);
static void stop_pipeline(ReceiverData *data);

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    java_vm = vm;
    return JNI_VERSION_1_6;
}

JNIEXPORT void JNICALL
Java_com_mentra_examples_android_media_GStreamerWhipReceiver_nativeInit(JNIEnv *env, jobject thiz) {
    ReceiverData *data = g_new0(ReceiverData, 1);
    g_mutex_init(&data->lock);
    data->app = (*env)->NewGlobalRef(env, thiz);

    jclass klass = (*env)->GetObjectClass(env, thiz);
    native_custom_data_field_id = (*env)->GetFieldID(env, klass, "nativeCustomData", "J");
    on_native_status_method_id = (*env)->GetMethodID(env, klass, "onNativeStatus", "(Ljava/lang/String;)V");
    on_native_frame_method_id = (*env)->GetMethodID(env, klass, "onNativeFrame", "(III[B)V");
    set_receiver_data(env, thiz, data);
    post_status(data, "GStreamer initialized");
}

JNIEXPORT void JNICALL
Java_com_mentra_examples_android_media_GStreamerWhipReceiver_nativeFinalize(JNIEnv *env, jobject thiz) {
    ReceiverData *data = get_receiver_data(env, thiz);
    if (!data) {
        return;
    }

    stop_pipeline(data);
    (*env)->DeleteGlobalRef(env, data->app);
    g_mutex_clear(&data->lock);
    g_free(data);
    set_receiver_data(env, thiz, NULL);
}

JNIEXPORT void JNICALL
Java_com_mentra_examples_android_media_GStreamerWhipReceiver_nativeStart(JNIEnv *env,
                                                                                 jobject thiz,
                                                                                 jstring bind_uri) {
    ReceiverData *data = get_receiver_data(env, thiz);
    if (!data) {
        return;
    }

    const char *bind_uri_chars = (*env)->GetStringUTFChars(env, bind_uri, NULL);
    stop_pipeline(data);
    prefer_software_h264_decoder();

    gchar *pipeline_description = g_strdup_printf(
        "whipserversrc name=src signaller::host-addr=%s stun-server=stun://stun.l.google.com:19302 "
        "src. ! queue name=video_queue leaky=downstream max-size-buffers=1 max-size-bytes=0 max-size-time=0 "
        "! videoscale ! videoconvert "
        "! video/x-raw,format=RGBA,width=480,height=270 "
        "! appsink name=video_sink emit-signals=false max-buffers=1 drop=true sync=false wait-on-eos=false "
        "src. ! queue name=audio_queue leaky=downstream max-size-buffers=1 max-size-bytes=0 max-size-time=0 "
        "! audio/x-opus ! fakesink sync=false",
        bind_uri_chars
    );
    (*env)->ReleaseStringUTFChars(env, bind_uri, bind_uri_chars);

    GError *parse_error = NULL;
    GstElement *pipeline = gst_parse_launch(pipeline_description, &parse_error);
    g_free(pipeline_description);

    if (!pipeline) {
        gchar *message = g_strdup_printf("Unable to create GStreamer pipeline: %s",
                                         parse_error ? parse_error->message : "unknown error");
        post_status(data, message);
        LOGE("%s", message);
        g_free(message);
        if (parse_error) {
            g_error_free(parse_error);
        }
        return;
    }
    if (parse_error) {
        gchar *message = g_strdup_printf("Pipeline warning: %s", parse_error->message);
        post_status(data, message);
        g_free(message);
        g_error_free(parse_error);
    }

    GstElement *source = gst_bin_get_by_name(GST_BIN(pipeline), "src");
    if (source) {
        set_string_array_property(G_OBJECT(source), "video-codecs", "H264");
        set_string_array_property(G_OBJECT(source), "audio-codecs", "OPUS");
        g_signal_connect(source, "request-encoded-filter", G_CALLBACK(on_request_encoded_filter), NULL);
        gst_object_unref(source);
    }

    GstElement *app_sink = gst_bin_get_by_name(GST_BIN(pipeline), "video_sink");
    if (app_sink) {
        static GstAppSinkCallbacks callbacks = { NULL, NULL, on_new_video_sample, NULL, NULL };
        gst_app_sink_set_callbacks(GST_APP_SINK(app_sink), &callbacks, data, NULL);
    }

    GstBus *bus = gst_element_get_bus(pipeline);

    g_mutex_lock(&data->lock);
    data->pipeline = pipeline;
    data->app_sink = app_sink;
    data->bus = bus;
    data->bus_thread_stop = FALSE;
    data->rendered_frames = 0;
    data->bus_thread = g_thread_new("mentra-gst-bus", bus_thread_func, data);
    g_mutex_unlock(&data->lock);

    GstStateChangeReturn state = gst_element_set_state(pipeline, GST_STATE_PLAYING);
    if (state == GST_STATE_CHANGE_FAILURE) {
        post_status(data, "GStreamer pipeline failed to enter PLAYING");
        stop_pipeline(data);
        return;
    }

    post_status(data, "GStreamer WHIP receiver PLAYING");
}

JNIEXPORT void JNICALL
Java_com_mentra_examples_android_media_GStreamerWhipReceiver_nativeStop(JNIEnv *env, jobject thiz) {
    ReceiverData *data = get_receiver_data(env, thiz);
    if (!data) {
        return;
    }
    stop_pipeline(data);
}

JNIEXPORT void JNICALL
Java_com_mentra_examples_android_media_GStreamerWhipReceiver_nativeSurfaceInit(JNIEnv *env,
                                                                                       jobject thiz,
                                                                                       jobject surface) {
    (void)env;
    (void)thiz;
    (void)surface;
}

JNIEXPORT void JNICALL
Java_com_mentra_examples_android_media_GStreamerWhipReceiver_nativeSurfaceFinalize(JNIEnv *env,
                                                                                           jobject thiz) {
    (void)env;
    (void)thiz;
}

static ReceiverData *get_receiver_data(JNIEnv *env, jobject thiz) {
    if (!native_custom_data_field_id) {
        return NULL;
    }
    return (ReceiverData *)(gintptr)(*env)->GetLongField(env, thiz, native_custom_data_field_id);
}

static void set_receiver_data(JNIEnv *env, jobject thiz, ReceiverData *data) {
    if (native_custom_data_field_id) {
        (*env)->SetLongField(env, thiz, native_custom_data_field_id, (jlong)(gintptr)data);
    }
}

static void post_status(ReceiverData *data, const char *message) {
    if (!data || !data->app || !java_vm || !on_native_status_method_id || !message) {
        return;
    }

    JNIEnv *env = NULL;
    gboolean detach = FALSE;
    if ((*java_vm)->GetEnv(java_vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) {
        if ((*java_vm)->AttachCurrentThread(java_vm, &env, NULL) != JNI_OK) {
            return;
        }
        detach = TRUE;
    }

    LOGI("%s", message);
    jstring java_message = (*env)->NewStringUTF(env, message);
    (*env)->CallVoidMethod(env, data->app, on_native_status_method_id, java_message);
    (*env)->DeleteLocalRef(env, java_message);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
    }

    if (detach) {
        (*java_vm)->DetachCurrentThread(java_vm);
    }
}

static void post_frame(ReceiverData *data, gint width, gint height, gint stride, const guint8 *bytes, gsize size) {
    if (!data || !data->app || !java_vm || !on_native_frame_method_id || !bytes || size == 0) {
        return;
    }

    JNIEnv *env = NULL;
    gboolean detach = FALSE;
    if ((*java_vm)->GetEnv(java_vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) {
        if ((*java_vm)->AttachCurrentThread(java_vm, &env, NULL) != JNI_OK) {
            return;
        }
        detach = TRUE;
    }

    if (size <= (gsize)G_MAXINT) {
        jbyteArray frame = (*env)->NewByteArray(env, (jsize)size);
        if (frame) {
            (*env)->SetByteArrayRegion(env, frame, 0, (jsize)size, (const jbyte *)bytes);
            (*env)->CallVoidMethod(env, data->app, on_native_frame_method_id,
                                   (jint)width, (jint)height, (jint)stride, frame);
            (*env)->DeleteLocalRef(env, frame);
        }
    }
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
    }

    if (detach) {
        (*java_vm)->DetachCurrentThread(java_vm);
    }
}

static void prefer_software_h264_decoder(void) {
    GstRegistry *registry = gst_registry_get();
    GstPluginFeature *openh264 = gst_registry_lookup_feature(registry, "openh264dec");
    if (openh264) {
        gst_plugin_feature_set_rank(openh264, GST_RANK_PRIMARY + 100);
        LOGI("Raised openh264dec rank for raw appsink preview");
        gst_object_unref(openh264);
    } else {
        LOGI("openh264dec is not available; GStreamer will use its default H.264 decoder");
    }

    GList *features = gst_registry_get_feature_list(registry, GST_TYPE_ELEMENT_FACTORY);
    for (GList *node = features; node != NULL; node = node->next) {
        GstPluginFeature *feature = GST_PLUGIN_FEATURE(node->data);
        const gchar *name = gst_plugin_feature_get_name(feature);
        if (name && g_str_has_prefix(name, "amcviddec-")) {
            gst_plugin_feature_set_rank(feature, GST_RANK_NONE);
            LOGI("Lowered %s rank for raw appsink preview", name);
        }
    }
    gst_plugin_feature_list_free(features);
}

static gboolean set_string_array_property(GObject *object, const gchar *property, const gchar *value) {
    GParamSpec *spec = g_object_class_find_property(G_OBJECT_GET_CLASS(object), property);
    if (!spec) {
        return FALSE;
    }

    GValue array = G_VALUE_INIT;
    GValue item = G_VALUE_INIT;
    g_value_init(&array, GST_TYPE_ARRAY);
    g_value_init(&item, G_TYPE_STRING);
    g_value_set_string(&item, value);
    gst_value_array_append_value(&array, &item);
    g_object_set_property(object, property, &array);
    g_value_unset(&item);
    g_value_unset(&array);
    return TRUE;
}

static GstElement *on_request_encoded_filter(GstElement *source,
                                             const gchar *producer_id,
                                             const gchar *pad_name,
                                             GstCaps *allowed_caps,
                                             gpointer user_data) {
    (void)source;
    (void)producer_id;
    (void)pad_name;
    (void)user_data;
    if (!allowed_caps) {
        return NULL;
    }

    gchar *caps_string = gst_caps_to_string(allowed_caps);
    gboolean wants_h264 = caps_string && g_strrstr(caps_string, "video/x-h264") != NULL;
    g_free(caps_string);
    if (!wants_h264) {
        return NULL;
    }

    GstElement *parser = gst_element_factory_make("h264parse", NULL);
    if (parser) {
        g_object_set(G_OBJECT(parser),
                     "config-interval", -1,
                     "disable-passthrough", TRUE,
                     NULL);
    }
    return parser;
}

static GstFlowReturn on_new_video_sample(GstAppSink *appsink, gpointer user_data) {
    ReceiverData *data = (ReceiverData *)user_data;
    GstSample *sample = gst_app_sink_pull_sample(appsink);
    if (!sample) {
        return GST_FLOW_OK;
    }

    GstCaps *caps = gst_sample_get_caps(sample);
    GstBuffer *buffer = gst_sample_get_buffer(sample);
    GstVideoInfo info;
    if (!caps || !buffer || !gst_video_info_from_caps(&info, caps)) {
        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }

    GstMapInfo map;
    if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) {
        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }

    const gint width = GST_VIDEO_INFO_WIDTH(&info);
    const gint height = GST_VIDEO_INFO_HEIGHT(&info);
    const gint stride = GST_VIDEO_INFO_PLANE_STRIDE(&info, 0);
    const gsize image_bytes = (gsize)stride * (gsize)height;

    if (width > 0 && height > 0 && stride >= width * 4 && map.size >= image_bytes) {
        post_frame(data, width, height, stride, map.data, image_bytes);

        guint frame_number = g_atomic_int_add((gint *)&data->rendered_frames, 1) + 1;
        if (frame_number == 1 || frame_number % 30 == 0) {
            gchar *message = g_strdup_printf("Rendered %u frames (%dx%d)", frame_number, width, height);
            post_status(data, message);
            g_free(message);
        }
    }

    gst_buffer_unmap(buffer, &map);
    gst_sample_unref(sample);
    return GST_FLOW_OK;
}

static gpointer bus_thread_func(gpointer user_data) {
    ReceiverData *data = (ReceiverData *)user_data;
    while (TRUE) {
        g_mutex_lock(&data->lock);
        gboolean should_stop = data->bus_thread_stop || data->bus == NULL;
        GstBus *bus = data->bus ? gst_object_ref(data->bus) : NULL;
        GstElement *pipeline = data->pipeline ? gst_object_ref(data->pipeline) : NULL;
        g_mutex_unlock(&data->lock);

        if (should_stop || !bus) {
            if (pipeline) {
                gst_object_unref(pipeline);
            }
            if (bus) {
                gst_object_unref(bus);
            }
            break;
        }

        GstMessage *message = gst_bus_timed_pop_filtered(
            bus,
            250 * GST_MSECOND,
            GST_MESSAGE_ERROR | GST_MESSAGE_WARNING | GST_MESSAGE_EOS | GST_MESSAGE_STATE_CHANGED
        );
        if (message) {
            switch (GST_MESSAGE_TYPE(message)) {
                case GST_MESSAGE_ERROR: {
                    GError *error = NULL;
                    gchar *debug = NULL;
                    gst_message_parse_error(message, &error, &debug);
                    gchar *text = g_strdup_printf("GStreamer error: %s", error ? error->message : "unknown");
                    post_status(data, text);
                    g_free(text);
                    if (debug) {
                        LOGE("GStreamer error debug: %s", debug);
                        g_free(debug);
                    }
                    if (error) {
                        g_error_free(error);
                    }
                    break;
                }
                case GST_MESSAGE_WARNING: {
                    GError *warning = NULL;
                    gchar *debug = NULL;
                    gst_message_parse_warning(message, &warning, &debug);
                    gchar *text = g_strdup_printf("GStreamer warning: %s", warning ? warning->message : "unknown");
                    post_status(data, text);
                    g_free(text);
                    if (debug) {
                        LOGI("GStreamer warning debug: %s", debug);
                        g_free(debug);
                    }
                    if (warning) {
                        g_error_free(warning);
                    }
                    break;
                }
                case GST_MESSAGE_EOS:
                    post_status(data, "GStreamer end of stream");
                    break;
                case GST_MESSAGE_STATE_CHANGED:
                    if (pipeline && GST_MESSAGE_SRC(message) == GST_OBJECT(pipeline)) {
                        GstState old_state;
                        GstState new_state;
                        GstState pending_state;
                        gst_message_parse_state_changed(message, &old_state, &new_state, &pending_state);
                        gchar *text = g_strdup_printf("Pipeline %s -> %s",
                                                      gst_element_state_get_name(old_state),
                                                      gst_element_state_get_name(new_state));
                        post_status(data, text);
                        g_free(text);
                    }
                    break;
                default:
                    break;
            }
            gst_message_unref(message);
        }

        if (pipeline) {
            gst_object_unref(pipeline);
        }
        gst_object_unref(bus);
    }
    return NULL;
}

static void stop_pipeline(ReceiverData *data) {
    if (!data) {
        return;
    }

    GThread *thread = NULL;
    GstElement *pipeline = NULL;
    GstElement *app_sink = NULL;
    GstBus *bus = NULL;

    g_mutex_lock(&data->lock);
    data->bus_thread_stop = TRUE;
    thread = data->bus_thread;
    data->bus_thread = NULL;
    pipeline = data->pipeline;
    app_sink = data->app_sink;
    bus = data->bus;
    data->pipeline = NULL;
    data->app_sink = NULL;
    data->bus = NULL;
    g_mutex_unlock(&data->lock);

    if (app_sink) {
        static GstAppSinkCallbacks empty_callbacks = { NULL, NULL, NULL, NULL, NULL };
        gst_app_sink_set_callbacks(GST_APP_SINK(app_sink), &empty_callbacks, NULL, NULL);
    }
    if (pipeline) {
        gst_element_set_state(pipeline, GST_STATE_NULL);
        gst_element_get_state(pipeline, NULL, NULL, 500 * GST_MSECOND);
    }
    if (thread) {
        g_thread_join(thread);
    }
    if (bus) {
        gst_object_unref(bus);
    }
    if (app_sink) {
        gst_object_unref(app_sink);
    }
    if (pipeline) {
        gst_object_unref(pipeline);
        post_status(data, "Receiver stopped");
    }
}
