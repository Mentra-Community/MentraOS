// Exercise the patched react-native-webview miniapp origin handler on WebKit, without React Native.
// Run with scripts/test-webview-miniapp-origin.sh on macOS.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#import "RNCMiniappSchemeHandler.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
  if (!condition) {
    NSLog(@"FAIL: %@", message);
    failures++;
  }
}

static NSString *writeFile(NSString *path, NSString *contents) {
  [[NSFileManager defaultManager] createDirectoryAtPath:path.stringByDeletingLastPathComponent
                            withIntermediateDirectories:YES attributes:nil error:nil];
  [contents writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
  return path;
}

static NSURL *url(NSString *string) {
  return [NSURL URLWithString:string];
}

static NSString *realPath(NSString *path) {
  char resolved[PATH_MAX];
  return realpath(path.fileSystemRepresentation, resolved) ? @(resolved) : nil;
}

static RNCMiniappResponse *get(NSString *string, NSString *packageName, NSString *root, NSString *method,
                               NSString *range) {
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url(string)];
  request.HTTPMethod = method ?: @"GET";
  if (range) [request setValue:range forHTTPHeaderField:@"Range"];
  return [RNCMiniappSchemeHandler responseForRequest:request packageName:packageName rootDir:root];
}

static void verifyPackageNames(void) {
  for (NSString *name in @[ @"com.mentra.notes", @"com.my_site.app", @"io.github.alice.tool2" ]) {
    check([RNCMiniappSchemeHandler isValidPackageName:name], [NSString stringWithFormat:@"accept %@", name]);
  }
  for (NSString *name in @[ @"", @"com", @"Com.mentra.notes", @"com.my-site.app", @"com..notes", @"1com.notes",
                            @"com._notes", @"com.notes.", @"com/notes.app" ]) {
    check(![RNCMiniappSchemeHandler isValidPackageName:name], [NSString stringWithFormat:@"refuse %@", name]);
  }
}

static void verifyResolution(NSString *base) {
  NSString *pkg = @"com.test.alpha";
  NSString *root = [base stringByAppendingPathComponent:@"alpha"];
  NSString *resolvedRoot = realPath(root);
  NSString *(^resolve)(NSString *) = ^NSString *(NSString *string) {
    return [RNCMiniappSchemeHandler resolveFileForURL:url(string) packageName:pkg rootDir:root];
  };

  check([resolve(@"miniapp://com.test.alpha/index.html") isEqualToString:[resolvedRoot stringByAppendingPathComponent:@"index.html"]],
        @"serve a file at the root");
  check([resolve(@"miniapp://com.test.alpha/ui/data.json?x=1#y") hasSuffix:@"/alpha/ui/data.json"],
        @"serve a nested file, ignoring the query and fragment");
  check([resolve(@"miniapp://com.test.alpha/ui/with%20space.txt") hasSuffix:@"/ui/with space.txt"],
        @"decode an escaped name");
  check([resolve(@"miniapp://com.test.alpha/link-in") hasSuffix:@"/alpha/ui/data.json"],
        @"follow a symlink that stays inside the root");
  check([[RNCMiniappSchemeHandler resolveFileForURL:url(@"miniapp://com.test.alpha/index.html")
                                         packageName:pkg
                                             rootDir:[NSURL fileURLWithPath:root].absoluteString]
            hasSuffix:@"/alpha/index.html"],
        @"accept the root as a file:// URL");

  NSArray<NSString *> *refused = @[
    @"miniapp://com.test.beta/index.html",          // another package's host
    @"miniapp://COM.TEST.ALPHA/index.html",         // not the exact host
    @"miniapp://com.test.alpha:8080/index.html",    // a port
    @"miniapp://user@com.test.alpha/index.html",    // credentials
    @"https://com.test.alpha/index.html",           // another scheme
    @"file:///etc/hosts",
    @"miniapp://com.test.alpha/",                   // the root directory
    @"miniapp://com.test.alpha/ui",                 // a directory
    @"miniapp://com.test.alpha/missing.html",
    @"miniapp://com.test.alpha/ui/../index.html",   // a dot segment
    @"miniapp://com.test.alpha/ui/./data.json",
    @"miniapp://com.test.alpha/ui/%2e%2e/index.html",
    @"miniapp://com.test.alpha/%2E%2E/secret.txt",
    @"miniapp://com.test.alpha/ui%2Fdata.json",     // an encoded separator
    @"miniapp://com.test.alpha/ui%2fdata.json",
    @"miniapp://com.test.alpha/ui%5Cdata.json",
    @"miniapp://com.test.alpha/index.html%00.png",
    @"miniapp://com.test.alpha/link-out",           // a symlink out of the root
    @"miniapp://com.test.alpha/link-dir-out/secret.txt",
    @"miniapp://com.test.alpha/link-sibling",       // a sibling that shares the root's prefix
  ];
  for (NSString *string in refused) {
    check(resolve(string) == nil, [NSString stringWithFormat:@"refuse %@", string]);
  }
  check([RNCMiniappSchemeHandler resolveFileForURL:url(@"miniapp://com.test.alpha/index.html")
                                       packageName:pkg
                                           rootDir:[base stringByAppendingPathComponent:@"missing"]] == nil,
        @"refuse everything when the root is missing");
  check([RNCMiniappSchemeHandler resolveFileForURL:url(@"miniapp://com.test.alpha/index.html")
                                       packageName:pkg
                                           rootDir:@"alpha"] == nil,
        @"refuse a relative root");
  check([RNCMiniappSchemeHandler resolveFileForURL:url(@"miniapp://Com.Test/index.html")
                                       packageName:@"Com.Test"
                                           rootDir:root] == nil,
        @"refuse everything for an invalid package name");
}

static void verifyResponses(NSString *base) {
  NSString *pkg = @"com.test.alpha";
  NSString *root = [base stringByAppendingPathComponent:@"alpha"];

  RNCMiniappResponse *page = get(@"miniapp://com.test.alpha/index.html", pkg, root, nil, nil);
  check(page.statusCode == 200, @"serve the page with 200");
  check([page.headers[@"Content-Type"] isEqualToString:@"text/html; charset=utf-8"], @"label HTML");
  check([page.headers[@"Cache-Control"] isEqualToString:@"no-store"], @"never cache");
  check([page.headers[@"X-Content-Type-Options"] isEqualToString:@"nosniff"], @"no sniffing");
  check(page.headers[@"Access-Control-Allow-Origin"] == nil, @"no CORS grant");
  check([page.headers[@"Content-Length"] integerValue] == (NSInteger)page.body.length && page.body.length > 0,
        @"Content-Length matches the body");

  check([get(@"miniapp://com.test.alpha/ui/app.js", pkg, root, nil, nil).headers[@"Content-Type"]
            isEqualToString:@"text/javascript; charset=utf-8"],
        @"label JavaScript");
  check([[RNCMiniappSchemeHandler contentTypeForPath:@"a/b.CSS"] isEqualToString:@"text/css; charset=utf-8"], @"label CSS");
  check([[RNCMiniappSchemeHandler contentTypeForPath:@"a/b.wasm"] isEqualToString:@"application/wasm"], @"label wasm");
  check([[RNCMiniappSchemeHandler contentTypeForPath:@"a/b.mp4"] isEqualToString:@"video/mp4"], @"label video");
  check([[RNCMiniappSchemeHandler contentTypeForPath:@"a/b.unknown"] isEqualToString:@"application/octet-stream"],
        @"label unknown files as bytes");

  RNCMiniappResponse *missing = get(@"miniapp://com.test.beta/index.html", pkg, root, nil, nil);
  check(missing.statusCode == 404, @"404 another package's host");
  check([missing.headers[@"Cache-Control"] isEqualToString:@"no-store"], @"never cache a 404");
  check(get(@"miniapp://com.test.alpha/link-out", pkg, root, nil, nil).statusCode == 404, @"404 a symlink out");

  RNCMiniappResponse *head = get(@"miniapp://com.test.alpha/index.html", pkg, root, @"HEAD", nil);
  check(head.statusCode == 200 && head.body.length == 0 &&
            [head.headers[@"Content-Length"] isEqualToString:page.headers[@"Content-Length"]],
        @"HEAD sends headers only");
  RNCMiniappResponse *post = get(@"miniapp://com.test.alpha/index.html", pkg, root, @"POST", nil);
  check(post.statusCode == 405 && [post.headers[@"Allow"] isEqualToString:@"GET, HEAD"], @"405 other methods");

  NSString *media = @"miniapp://com.test.alpha/media.bin";
  RNCMiniappResponse *full = get(media, pkg, root, nil, nil);
  check(full.statusCode == 200 && full.body.length == 1000 && [full.headers[@"Accept-Ranges"] isEqualToString:@"bytes"],
        @"serve media whole");
  RNCMiniappResponse *slice = get(media, pkg, root, nil, @"bytes=10-19");
  check(slice.statusCode == 206 && slice.body.length == 10 &&
            [slice.headers[@"Content-Range"] isEqualToString:@"bytes 10-19/1000"] &&
            [slice.body isEqualToData:[full.body subdataWithRange:NSMakeRange(10, 10)]],
        @"serve a byte range");
  RNCMiniappResponse *tail = get(media, pkg, root, nil, @"bytes=-100");
  check(tail.statusCode == 206 && tail.body.length == 100 && [tail.headers[@"Content-Range"] isEqualToString:@"bytes 900-999/1000"],
        @"serve a suffix range");
  RNCMiniappResponse *open = get(media, pkg, root, nil, @"bytes=990-");
  check(open.statusCode == 206 && open.body.length == 10, @"serve an open range");
  RNCMiniappResponse *clamped = get(media, pkg, root, nil, @"bytes=995-5000");
  check(clamped.statusCode == 206 && clamped.body.length == 5, @"clamp a range past the end");
  RNCMiniappResponse *beyond = get(media, pkg, root, nil, @"bytes=1000-");
  check(beyond.statusCode == 416 && [beyond.headers[@"Content-Range"] isEqualToString:@"bytes */1000"],
        @"416 a range past the end");
  check(get(media, pkg, root, nil, @"bytes=0-1,5-6").statusCode == 200, @"ignore several ranges");
  check(get(media, pkg, root, nil, @"items=0-1").statusCode == 200, @"ignore other range units");
}

#pragma mark - WebKit

@interface PageLoader : NSObject <WKNavigationDelegate>
@property (nonatomic) BOOL done;
@property (nonatomic) BOOL failed;
@end
@implementation PageLoader
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { self.done = YES; }
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  self.failed = YES;
  self.done = YES;
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  self.failed = YES;
  self.done = YES;
}
@end

static BOOL spinUntil(BOOL (^condition)(void), NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!condition() && [deadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  return condition();
}

static WKWebView *openPage(NSString *pkg, NSString *root, WKWebsiteDataStore *store, PageLoader *loader) {
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  config.websiteDataStore = store;
  [config setURLSchemeHandler:[[RNCMiniappSchemeHandler alloc] initWithPackageName:pkg rootDir:root]
                 forURLScheme:RNCMiniappOriginScheme];
  WKWebView *webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 320, 480) configuration:config];
  webView.navigationDelegate = loader;
  [webView loadRequest:[NSURLRequest requestWithURL:url([NSString stringWithFormat:@"miniapp://%@/index.html", pkg])]];
  check(spinUntil(^BOOL { return loader.done; }, 30) && !loader.failed,
        [NSString stringWithFormat:@"load miniapp://%@/index.html", pkg]);
  return webView;
}

static id run(WKWebView *webView, NSString *body) {
  __block BOOL finished = NO;
  __block id value = nil;
  [webView callAsyncJavaScript:body arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
             completionHandler:^(id result, NSError *error) {
               value = error ? [NSString stringWithFormat:@"error: %@", error.localizedDescription] : result;
               finished = YES;
             }];
  check(spinUntil(^BOOL { return finished; }, 30), [NSString stringWithFormat:@"run %@", body]);
  if (getenv("MINIAPP_ORIGIN_VERBOSE")) NSLog(@"%@ => %@", body, value);
  return value;
}

/** Whether this session can run WebKit at all (a CI service without a GUI session may not). */
static BOOL webKitAvailable(void) {
  PageLoader *loader = [PageLoader new];
  WKWebView *webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)
                                          configuration:[WKWebViewConfiguration new]];
  webView.navigationDelegate = loader;
  [webView loadHTMLString:@"<p>ok</p>" baseURL:nil];
  return spinUntil(^BOOL { return loader.done; }, 20) && !loader.failed;
}

static void verifyWebKit(NSString *base) {
  [NSApplication sharedApplication];
  if (!webKitAvailable()) {
    NSLog(@"SKIP: WebKit can't load pages in this session; the WebView checks did not run");
    return;
  }
  WKWebsiteDataStore *store = [WKWebsiteDataStore nonPersistentDataStore];
  PageLoader *alphaLoader = [PageLoader new];
  PageLoader *betaLoader = [PageLoader new];
  WKWebView *alpha = openPage(@"com.test.alpha", [base stringByAppendingPathComponent:@"alpha"], store, alphaLoader);
  WKWebView *beta = openPage(@"com.test.beta", [base stringByAppendingPathComponent:@"beta"], store, betaLoader);
  NSString *secret = [NSURL fileURLWithPath:[base stringByAppendingPathComponent:@"secret.txt"]].absoluteString;

  check([run(alpha, @"return location.origin") isEqual:@"miniapp://com.test.alpha"], @"the page's origin is its package");
  check([run(alpha, @"return window.isSecureContext") isEqual:@YES], @"the page is a secure context");
  check([run(alpha, @"return typeof crypto.subtle") isEqual:@"object"], @"the page has Web Crypto");
  check([run(alpha, @"const r = await fetch('/ui/data.json'); return r.status + ':' + (await r.json()).who")
            isEqual:@"200:alpha"],
        @"fetch its own file");
  check([run(alpha, @"const r = await fetch('/ui/data.json'); return r.headers.get('cache-control')") isEqual:@"no-store"],
        @"its responses are not cached");
  check([run(alpha, @"const r = await fetch('/media.bin', {headers: {Range: 'bytes=0-9'}}); "
                    @"return r.status + ':' + (await r.arrayBuffer()).byteLength")
            isEqual:@"206:10"],
        @"fetch a byte range");
  check([run(alpha, @"const r = await fetch('/link-out'); return r.status") isEqual:@404], @"a symlink out is 404");
  check([run(alpha, @"const r = await fetch('/missing'); return r.status") isEqual:@404], @"a missing file is 404");

  NSString *(^blocked)(NSString *) = ^NSString *(NSString *target) {
    return run(alpha, [NSString stringWithFormat:@"try { const r = await fetch(%@); return 'read ' + r.status + ' ' + "
                                                  @"(await r.text()).slice(0, 20) } catch (e) { return 'blocked' }",
                                                  target]);
  };
  check([blocked(@"'miniapp://com.test.beta/index.html'") hasPrefix:@"read 404"] ||
            [blocked(@"'miniapp://com.test.beta/index.html'") isEqual:@"blocked"],
        @"another package's origin is not readable");
  check([blocked([NSString stringWithFormat:@"'%@'", secret]) isEqual:@"blocked"], @"fetch(file://) fails");
  check([blocked(@"'file:///etc/hosts'") isEqual:@"blocked"], @"fetch(file:///etc/hosts) fails");
  NSString *xhr = run(alpha, [NSString stringWithFormat:
      @"return await new Promise(done => { const x = new XMLHttpRequest(); "
      @"x.onload = () => done('read ' + x.responseText.slice(0, 20)); x.onerror = () => done('blocked'); "
      @"try { x.open('GET', '%@'); x.send() } catch (e) { done('blocked') } })", secret]);
  check([xhr isEqual:@"blocked"], @"XMLHttpRequest of a file fails");
  NSString *frame = run(alpha, [NSString stringWithFormat:
      @"return await new Promise(done => { const f = document.createElement('iframe'); "
      @"f.onload = () => { try { done('read ' + f.contentDocument.body.innerText.slice(0, 20)) } catch (e) { done('blocked') } }; "
      @"setTimeout(() => done('blocked'), 3000); f.src = '%@'; document.body.appendChild(f) })", secret]);
  check([frame isEqual:@"blocked"], [NSString stringWithFormat:@"an iframe of a file is unreadable (%@)", frame]);
  NSString *otherFrame = run(alpha,
      @"return await new Promise(done => { const f = document.createElement('iframe'); "
      @"f.onload = () => { try { done('read ' + f.contentDocument.body.innerText.slice(0, 20)) } catch (e) { done('blocked') } }; "
      @"setTimeout(() => done('blocked'), 3000); f.src = 'miniapp://com.test.beta/index.html'; document.body.appendChild(f) })");
  check(![otherFrame containsString:@"beta"], [NSString stringWithFormat:@"another package's page never loads (%@)", otherFrame]);

  run(alpha, @"localStorage.setItem('shared-key', 'alpha'); return true");
  check([run(beta, @"return String(localStorage.getItem('shared-key'))") isEqual:@"null"],
        @"another package can't read its localStorage");
  run(beta, @"localStorage.setItem('shared-key', 'beta'); return true");
  check([run(alpha, @"return localStorage.getItem('shared-key')") isEqual:@"alpha"], @"its localStorage is its own");
  check([run(beta, @"const r = await fetch('/ui/data.json'); return (await r.json()).who") isEqual:@"beta"],
        @"each package reads only its own files");
}

int main(void) {
  @autoreleasepool {
    NSString *base = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString];
    NSFileManager *files = [NSFileManager defaultManager];
    writeFile([base stringByAppendingPathComponent:@"secret.txt"], @"secret outside the root");
    writeFile([base stringByAppendingPathComponent:@"alphax/secret.txt"], @"secret beside the root");
    writeFile([base stringByAppendingPathComponent:@"alpha/index.html"], @"<!doctype html><html><body>alpha</body></html>");
    writeFile([base stringByAppendingPathComponent:@"alpha/ui/app.js"], @"window.loaded = true");
    writeFile([base stringByAppendingPathComponent:@"alpha/ui/data.json"], @"{\"who\":\"alpha\"}");
    writeFile([base stringByAppendingPathComponent:@"alpha/ui/with space.txt"], @"spaced");
    writeFile([base stringByAppendingPathComponent:@"beta/index.html"], @"<!doctype html><html><body>beta</body></html>");
    writeFile([base stringByAppendingPathComponent:@"beta/ui/data.json"], @"{\"who\":\"beta\"}");
    NSMutableData *media = [NSMutableData dataWithLength:1000];
    for (NSUInteger i = 0; i < media.length; i++) ((uint8_t *)media.mutableBytes)[i] = (uint8_t)(i % 251);
    [media writeToFile:[base stringByAppendingPathComponent:@"alpha/media.bin"] atomically:YES];
    [files createSymbolicLinkAtPath:[base stringByAppendingPathComponent:@"alpha/link-out"] withDestinationPath:@"../secret.txt" error:nil];
    [files createSymbolicLinkAtPath:[base stringByAppendingPathComponent:@"alpha/link-in"] withDestinationPath:@"ui/data.json" error:nil];
    [files createSymbolicLinkAtPath:[base stringByAppendingPathComponent:@"alpha/link-dir-out"] withDestinationPath:base error:nil];
    [files createSymbolicLinkAtPath:[base stringByAppendingPathComponent:@"alpha/link-sibling"]
                withDestinationPath:[base stringByAppendingPathComponent:@"alphax/secret.txt"] error:nil];

    verifyPackageNames();
    verifyResolution(base);
    verifyResponses(base);
    const char *skipWebKit = getenv("MINIAPP_ORIGIN_SKIP_WEBKIT");
    if (skipWebKit == NULL || skipWebKit[0] == '\0') {
      verifyWebKit(base);
    }

    [files removeItemAtPath:base error:nil];
    if (failures > 0) {
      NSLog(@"%d check(s) failed", failures);
      return 1;
    }
    NSLog(@"PASS: miniapp origin handler");
  }
  return 0;
}
