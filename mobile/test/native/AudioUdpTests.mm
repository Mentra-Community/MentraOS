// Run with mobile/scripts/test-audio-udp.sh on macOS after pod install.
#import "UdpSocketClient.h"
#import "GCDAsyncUdpSocket.h"
#import <netdb.h>
#include <atomic>

static std::atomic<int> lookups{0};
static dispatch_semaphore_t resolveGate;

// Instrument only CocoaAsyncSocket's resolver. Normal test destinations still
// pass through the system resolver; blocked/failing DNS is deterministic.
extern "C" int mentra_test_getaddrinfo(const char *host, const char *service,
                                      const struct addrinfo *hints, struct addrinfo **result) {
  lookups++;
  if (strcmp(host, "blocked.test") == 0) dispatch_semaphore_wait(resolveGate, DISPATCH_TIME_FOREVER);
  if (strcmp(host, "missing.test") == 0) return EAI_NONAME;
  return getaddrinfo("127.0.0.1", service, hints, result);
}

static void check(BOOL condition, NSString *message) {
  if (!condition) { NSLog(@"FAIL: %@", message); exit(1); }
}

static void until(BOOL (^done)(void), NSString *message) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3];
  while (!done() && [deadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
  }
  check(done(), message);
}

@interface EchoPeer : NSObject <GCDAsyncUdpSocketDelegate, SocketClientDelegate>
@property NSMutableArray<NSData *> *packets;
@property NSMutableArray<NSData *> *replies;
@end
@implementation EchoPeer
- (instancetype)init {
  if ((self = [super init])) { _packets = [NSMutableArray new]; _replies = [NSMutableArray new]; }
  return self;
}
- (void)udpSocket:(GCDAsyncUdpSocket *)socket didReceiveData:(NSData *)data
      fromAddress:(NSData *)address withFilterContext:(id)context {
  [self.packets addObject:data];
  [socket sendData:data toAddress:address withTimeout:1 tag:0];
}
- (void)onData:(UdpSocketClient *)client data:(NSData *)data host:(NSString *)host port:(uint16_t)port {
  [self.replies addObject:data];
}
@end

static UdpSocketClient *client(EchoPeer *peer) {
  UdpSocketClient *socket = [UdpSocketClient socketClientWithConfig:peer];
  NSError *error;
  check([socket bind:0 address:nil options:@{} error:&error], @"Bind client");
  return socket;
}

int main(void) {
  @autoreleasepool {
    EchoPeer *peer = [EchoPeer new];
    GCDAsyncUdpSocket *server = [[GCDAsyncUdpSocket alloc] initWithDelegate:peer delegateQueue:dispatch_get_main_queue()];
    NSError *error;
    check([server bindToPort:0 error:&error] && [server beginReceiving:&error], @"Start loopback peer");
    uint16_t port = server.localPort;
    const uint8_t bytes[] = {0, 255, 128, 1, 2, 3};
    NSData *payload = [NSData dataWithBytes:bytes length:sizeof(bytes)];

    // Pause DNS, enqueue data before connect completes, then verify exact bytes
    // and acknowledgments with only one resolver call for the entire socket.
    resolveGate = dispatch_semaphore_create(0);
    UdpSocketClient *connected = client(peer);
    __block int connects = 0, sends = 0;
    [connected connect:port address:@"blocked.test" callback:^(NSArray *args) {
      check(args.count == 0, @"Connect succeeded"); connects++;
    }];
    [connected send:payload remotePort:0 remoteAddress:nil callback:^(NSArray *args) {
      check(args.count == 0, @"First queued packet sent"); sends++;
    }];
    until(^BOOL { return lookups.load() == 1; }, @"DNS started");
    check(sends == 0 && connects == 0, @"Packets wait for DNS");
    dispatch_semaphore_signal(resolveGate);
    until(^BOOL { return peer.replies.count == 1 && sends == 1 && connects == 1; }, @"Queued packet echoed");
    for (int i = 1; i < 100; i++) {
      [connected send:payload remotePort:0 remoteAddress:nil callback:^(NSArray *args) {
        check(args.count == 0, @"Connected packet sent"); sends++;
      }];
      until(^BOOL { return sends == i + 1 && peer.replies.count == (NSUInteger)i + 1; }, @"Packet echoed");
    }
    check(lookups == 1, @"100 connected packets perform exactly one DNS lookup");
    for (NSData *data in peer.replies) check([data isEqual:payload], @"Binary bytes preserved");
    [connected close];

    // Ordinary callers keep the original unconnected, multi-destination API.
    UdpSocketClient *ordinary = client(peer);
    int before = lookups;
    __block int ordinarySends = 0;
    for (int i = 0; i < 3; i++) {
      [ordinary send:payload remotePort:port remoteAddress:i % 2 ? @"other.test" : @"audio.test"
            callback:^(NSArray *args) { check(args.count == 0, @"Unconnected send"); ordinarySends++; }];
    }
    until(^BOOL { return ordinarySends == 3 && peer.replies.count == 103; }, @"Unconnected replies");
    check(lookups == before + 3, @"Unconnected resolution behavior preserved");
    [ordinary close];

    // A fresh session/route resolves again and can reach a different peer port.
    GCDAsyncUdpSocket *other = [[GCDAsyncUdpSocket alloc] initWithDelegate:peer delegateQueue:dispatch_get_main_queue()];
    check([other bindToPort:0 error:&error] && [other beginReceiving:&error], @"Second peer");
    UdpSocketClient *replacement = client(peer);
    __block int replaced = 0;
    [replacement connect:other.localPort address:@"other.test" callback:^(NSArray *args) {
      check(args.count == 0, @"Replacement connected"); replaced++;
    }];
    [replacement send:payload remotePort:0 remoteAddress:nil callback:^(NSArray *args) {
      check(args.count == 0, @"Replacement sent"); replaced++;
    }];
    until(^BOOL { return replaced == 2 && peer.replies.count == 104; }, @"Replacement echoed");
    check(lookups == before + 4, @"Replacement performs a fresh lookup");
    [replacement close];

    UdpSocketClient *failed = client(peer);
    __block int failures = 0;
    [failed connect:port address:@"missing.test" callback:^(NSArray *args) {
      check(args.count == 1, @"Report DNS failure"); failures++;
    }];
    [failed send:payload remotePort:0 remoteAddress:nil callback:^(NSArray *args) {
      check(args.count == 1, @"Fail queued packet after DNS failure"); failures++;
    }];
    until(^BOOL { return failures == 2; }, @"Failure callbacks settle");
    [failed close];
    check(failures == 2, @"Close does not repeat failed callbacks");

    // Closing during DNS must settle all callbacks once and discard queued audio.
    UdpSocketClient *cancelled = client(peer);
    __block int cancelledCallbacks = 0;
    before = lookups;
    [cancelled connect:port address:@"blocked.test" callback:^(NSArray *args) {
      check(args.count == 1, @"Cancel connect"); cancelledCallbacks++;
    }];
    [cancelled send:payload remotePort:0 remoteAddress:nil callback:^(NSArray *args) {
      check(args.count == 1, @"Cancel pending send"); cancelledCallbacks++;
    }];
    until(^BOOL { return lookups == before + 1; }, @"Blocked resolver started");
    [cancelled close];
    check(cancelledCallbacks == 2, @"Close settles callbacks immediately");
    dispatch_semaphore_signal(resolveGate);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    check(cancelledCallbacks == 2 && peer.packets.count == 104, @"No late callback or packet after close");
    [server close]; [other close];
    NSLog(@"PASS: one lookup/100 packets, exact bytes/replies, unconnected sends, fresh peer, DNS failure, close during DNS");
  }
  return 0;
}
