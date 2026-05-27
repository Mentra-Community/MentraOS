#import "GStreamerWhipReceiver.h"

#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreGraphics/CoreGraphics.h>
#import <gst/app/gstappsink.h>
#import <gst/gst.h>
#import <gst/video/video.h>

#import "gst_ios_init.h"

static NSString * const GStreamerWhipReceiverErrorDomain = @"com.mentra.examples.ios-webrtc-receiver.gstreamer";

@interface GStreamerVideoContainerView : UIView
@property (nonatomic, strong) UIImageView *imageView;
@property (nonatomic, strong, nullable) UIImage *image;
@end

@implementation GStreamerVideoContainerView

- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        _imageView = [[UIImageView alloc] initWithFrame:self.bounds];
        _imageView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        _imageView.contentMode = UIViewContentModeScaleAspectFit;
        _imageView.backgroundColor = UIColor.blackColor;
        [self addSubview:_imageView];
    }
    return self;
}

- (void)setImage:(UIImage *)image {
    _image = image;
    self.imageView.image = image;
}

@end

static GstFlowReturn on_new_video_sample(GstAppSink *appsink, gpointer user_data);
static GstElement *on_request_encoded_filter(GstElement *source,
                                             const gchar *producer_id,
                                             const gchar *pad_name,
                                             GstCaps *allowed_caps,
                                             gpointer user_data);

@interface GStreamerWhipReceiver ()
@property (nonatomic, strong, readwrite) UIView *videoView;
@property (nonatomic, copy, readwrite, nullable) NSString *whipURL;
@property (nonatomic, assign) GstElement *pipeline;
@property (nonatomic, assign) GstBus *bus;
@property (nonatomic, strong, nullable) dispatch_source_t busTimer;
@property (atomic, assign) NSUInteger renderedFrameCount;
- (GstFlowReturn)handleVideoSampleFromAppSink:(GstAppSink *)appsink;
@end

@implementation GStreamerWhipReceiver

- (instancetype)init {
    self = [super init];
    if (self) {
        _videoView = [[GStreamerVideoContainerView alloc] initWithFrame:CGRectZero];
        _videoView.backgroundColor = UIColor.blackColor;
    }
    return self;
}

- (void)dealloc {
    [self stop];
}

- (BOOL)startWithAdvertisedHost:(NSString *)advertisedHost
                           port:(NSInteger)port
                          error:(NSError **)error {
    [self stop];
    [self initializeGStreamerOnce];

    NSString *host = advertisedHost.length > 0 ? advertisedHost : @"127.0.0.1";
    self.whipURL = [NSString stringWithFormat:@"http://%@:%ld/whip/endpoint", host, (long)port];
	    NSString *bindAddress = [NSString stringWithFormat:@"http://0.0.0.0:%ld", (long)port];
	    NSString *pipelineDescription = [NSString stringWithFormat:
	        @"whipserversrc name=src signaller::host-addr=%@ stun-server=stun://stun.l.google.com:19302 "
	        "src. ! queue name=video_queue leaky=downstream max-size-buffers=2 max-size-bytes=0 max-size-time=0 "
	        "! videoscale ! videoconvert "
	        "! video/x-raw,format=BGRA,width=480,height=270 "
	        "! appsink name=video_sink emit-signals=false max-buffers=1 drop=true sync=false wait-on-eos=false "
	        "src. ! queue name=audio_queue ! audio/x-raw ! fakesink sync=false",
	        bindAddress
	    ];

    GError *parseError = NULL;
    self.pipeline = gst_parse_launch(pipelineDescription.UTF8String, &parseError);
    if (!self.pipeline) {
        [self fillError:error code:1 message:[NSString stringWithFormat:@"Unable to create GStreamer pipeline: %s", parseError ? parseError->message : "unknown error"]];
        if (parseError) {
            g_error_free(parseError);
        }
        return NO;
    }
    if (parseError) {
        [self notify:[NSString stringWithFormat:@"Pipeline warning: %s", parseError->message]];
        g_error_free(parseError);
    }

	    GstElement *source = gst_bin_get_by_name(GST_BIN(self.pipeline), "src");
	    if (source) {
	        [self setStringArrayProperty:"video-codecs" value:"H264" onObject:G_OBJECT(source)];
	        [self setStringArrayProperty:"audio-codecs" value:"OPUS" onObject:G_OBJECT(source)];
	        g_signal_connect(source, "request-encoded-filter", G_CALLBACK(on_request_encoded_filter), NULL);
	        gst_object_unref(source);
	    }

	    GstElement *sink = gst_bin_get_by_name(GST_BIN(self.pipeline), "video_sink");
	    if (sink) {
	        static GstAppSinkCallbacks callbacks = { NULL, NULL, on_new_video_sample, NULL, NULL };
	        gst_app_sink_set_callbacks(GST_APP_SINK(sink), &callbacks, (__bridge void *)self, NULL);
	        gst_object_unref(sink);
	    }

    self.bus = gst_element_get_bus(self.pipeline);
    [self startBusPolling];

    GstStateChangeReturn state = gst_element_set_state(self.pipeline, GST_STATE_PLAYING);
    if (state == GST_STATE_CHANGE_FAILURE) {
        [self stop];
        [self fillError:error code:2 message:@"GStreamer pipeline failed to enter PLAYING"];
        return NO;
    }

    [self notify:[NSString stringWithFormat:@"Listening at %@", self.whipURL]];
    return YES;
}

- (void)stop {
    if (self.busTimer) {
        dispatch_source_cancel(self.busTimer);
        self.busTimer = nil;
    }
	    if (self.pipeline) {
	        gst_element_set_state(self.pipeline, GST_STATE_NULL);
	        gst_object_unref(self.pipeline);
	        self.pipeline = NULL;
	    }
    if (self.bus) {
        gst_object_unref(self.bus);
        self.bus = NULL;
    }
        UIView *videoView = self.videoView;
        dispatch_async(dispatch_get_main_queue(), ^{
            if ([videoView isKindOfClass:[GStreamerVideoContainerView class]]) {
                ((GStreamerVideoContainerView *)videoView).image = nil;
            }
        });
	    self.whipURL = nil;
	    self.renderedFrameCount = 0;
	    [self notify:@"Receiver stopped"];
	}

- (void)initializeGStreamerOnce {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        gst_ios_init();
    });
}

- (void)setStringArrayProperty:(const gchar *)property value:(const gchar *)value onObject:(GObject *)object {
    GValue array = G_VALUE_INIT;
    GValue item = G_VALUE_INIT;
    g_value_init(&array, GST_TYPE_ARRAY);
    g_value_init(&item, G_TYPE_STRING);
    g_value_set_string(&item, value);
    gst_value_array_append_value(&array, &item);
    g_object_set_property(object, property, &array);
    g_value_unset(&item);
    g_value_unset(&array);
}

- (void)startBusPolling {
    if (!self.bus) {
        return;
    }
    dispatch_queue_t queue = dispatch_queue_create("com.mentra.examples.gstreamer.bus", DISPATCH_QUEUE_SERIAL);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
    __weak typeof(self) weakSelf = self;
    dispatch_source_set_event_handler(timer, ^{
        [weakSelf pollBus];
    });
    self.busTimer = timer;
    dispatch_resume(timer);
}

- (void)pollBus {
    if (!self.bus) {
        return;
    }

    GstMessage *message = NULL;
    while ((message = gst_bus_pop_filtered(self.bus, GST_MESSAGE_ERROR | GST_MESSAGE_WARNING | GST_MESSAGE_EOS | GST_MESSAGE_STATE_CHANGED))) {
        switch (GST_MESSAGE_TYPE(message)) {
            case GST_MESSAGE_ERROR: {
                GError *error = NULL;
                gchar *debug = NULL;
                gst_message_parse_error(message, &error, &debug);
                NSString *text = [NSString stringWithFormat:@"GStreamer error: %s", error ? error->message : "unknown"];
                [self notify:text];
                if (debug) {
                    [self notify:[NSString stringWithFormat:@"GStreamer error debug: %s", debug]];
                }
                if (debug) {
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
                NSString *text = [NSString stringWithFormat:@"GStreamer warning: %s", warning ? warning->message : "unknown"];
                [self notify:text];
                if (debug) {
                    [self notify:[NSString stringWithFormat:@"GStreamer warning debug: %s", debug]];
                }
                if (debug) {
                    g_free(debug);
                }
                if (warning) {
                    g_error_free(warning);
                }
                break;
            }
            case GST_MESSAGE_EOS:
                [self notify:@"GStreamer end of stream"];
                break;
            case GST_MESSAGE_STATE_CHANGED:
                if (GST_MESSAGE_SRC(message) == GST_OBJECT(self.pipeline)) {
                    GstState oldState;
                    GstState newState;
                    GstState pendingState;
                    gst_message_parse_state_changed(message, &oldState, &newState, &pendingState);
                    [self notify:[NSString stringWithFormat:@"Pipeline %@ -> %@", [self nameForState:oldState], [self nameForState:newState]]];
                }
                break;
            default:
                break;
        }
        gst_message_unref(message);
    }
}

- (GstFlowReturn)handleVideoSampleFromAppSink:(GstAppSink *)appsink {
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

    const int width = GST_VIDEO_INFO_WIDTH(&info);
    const int height = GST_VIDEO_INFO_HEIGHT(&info);
    const int stride = GST_VIDEO_INFO_PLANE_STRIDE(&info, 0);
    const size_t imageBytes = (size_t)stride * (size_t)height;

    UIImage *image = nil;
    if (width > 0 && height > 0 && stride > 0 && map.size >= imageBytes) {
        CFDataRef data = CFDataCreate(kCFAllocatorDefault, map.data, imageBytes);
        CGDataProviderRef provider = data ? CGDataProviderCreateWithCFData(data) : NULL;
        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        CGImageRef cgImage = NULL;
        if (provider && colorSpace) {
            cgImage = CGImageCreate((size_t)width,
                                    (size_t)height,
                                    8,
                                    32,
                                    (size_t)stride,
                                    colorSpace,
                                    kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst,
                                    provider,
                                    NULL,
                                    false,
                                    kCGRenderingIntentDefault);
        }
        if (cgImage) {
            image = [UIImage imageWithCGImage:cgImage];
            CGImageRelease(cgImage);
        }
        if (colorSpace) {
            CGColorSpaceRelease(colorSpace);
        }
        if (provider) {
            CGDataProviderRelease(provider);
        }
        if (data) {
            CFRelease(data);
        }
    }

    gst_buffer_unmap(buffer, &map);
    gst_sample_unref(sample);

    if (image) {
        NSUInteger frameNumber = self.renderedFrameCount + 1;
        self.renderedFrameCount = frameNumber;
        UIView *videoView = self.videoView;
        UIImage *frameImage = image;
        dispatch_async(dispatch_get_main_queue(), ^{
            if ([videoView isKindOfClass:[GStreamerVideoContainerView class]]) {
                ((GStreamerVideoContainerView *)videoView).image = frameImage;
            }
            void (^frameHandler)(void) = self.onFrameRendered;
            if (frameHandler) {
                frameHandler();
            }
        });
        if (frameNumber == 1 || frameNumber % 30 == 0) {
            [self notify:[NSString stringWithFormat:@"Rendered %lu frames (%dx%d)", (unsigned long)frameNumber, width, height]];
        }
    }

    return GST_FLOW_OK;
}

- (NSString *)nameForState:(GstState)state {
    return [NSString stringWithUTF8String:gst_element_state_get_name(state)];
}

- (void)notify:(NSString *)message {
    void (^handler)(NSString *) = self.onStateChanged;
    if (!handler) {
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        handler(message);
    });
}

- (void)fillError:(NSError **)error code:(NSInteger)code message:(NSString *)message {
    if (!error) {
        return;
    }
    *error = [NSError errorWithDomain:GStreamerWhipReceiverErrorDomain
                                 code:code
                             userInfo:@{NSLocalizedDescriptionKey: message}];
}

@end

static GstFlowReturn on_new_video_sample(GstAppSink *appsink, gpointer user_data) {
    GStreamerWhipReceiver *receiver = (__bridge GStreamerWhipReceiver *)user_data;
    return [receiver handleVideoSampleFromAppSink:appsink];
}

static GstElement *on_request_encoded_filter(GstElement *source,
                                             const gchar *producer_id,
                                             const gchar *pad_name,
                                             GstCaps *allowed_caps,
                                             gpointer user_data) {
    if (!allowed_caps) {
        return NULL;
    }

    gchar *capsString = gst_caps_to_string(allowed_caps);
    gboolean wantsH264 = capsString && g_strrstr(capsString, "video/x-h264") != NULL;
    if (capsString) {
        g_free(capsString);
    }
    if (!wantsH264) {
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
