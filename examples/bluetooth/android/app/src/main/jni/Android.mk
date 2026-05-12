LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)
LOCAL_MODULE := mentra_android_webrtc_receiver
LOCAL_SRC_FILES := gstreamer_whip_receiver.c
LOCAL_SHARED_LIBRARIES := gstreamer_android
LOCAL_LDLIBS := -llog -landroid
LOCAL_CFLAGS := -Wall -Wextra
include $(BUILD_SHARED_LIBRARY)

ifndef GSTREAMER_ROOT
ifndef GSTREAMER_ROOT_ANDROID
$(error GSTREAMER_ROOT_ANDROID is not defined)
endif
GSTREAMER_ROOT := $(GSTREAMER_ROOT_ANDROID)
endif

GSTREAMER_NDK_BUILD_PATH := $(GSTREAMER_ROOT)/share/gst-android/ndk-build
include $(GSTREAMER_NDK_BUILD_PATH)/plugins.mk

GSTREAMER_PLUGINS := \
	coreelements \
	app \
	typefindfunctions \
	pbtypes \
	videoconvertscale \
	videorate \
	playback \
	videoparsersbad \
	openh264 \
	androidmedia \
	tcp \
	udp \
	rtp \
	rtpmanager \
	srtp \
	dtls \
	nice \
	soup \
	webrtc \
	webrtchttp \
	rswebrtc
GSTREAMER_EXTRA_DEPS := gstreamer-app-1.0 gstreamer-video-1.0

include $(GSTREAMER_NDK_BUILD_PATH)/gstreamer-1.0.mk
