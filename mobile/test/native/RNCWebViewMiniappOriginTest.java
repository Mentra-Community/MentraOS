// Exercise the patched react-native-webview miniapp origin (Android) on the JVM, without Android.
// Run with scripts/test-webview-miniapp-origin-android.sh, which extracts RNCWebViewClient.MiniappOrigin.
package com.reactnativecommunity.webview;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.stream.Stream;

public class RNCWebViewMiniappOriginTest {
  private static int failures = 0;

  private static void check(boolean condition, String message) {
    if (!condition) {
      System.err.println("FAIL: " + message);
      failures++;
    }
  }

  private static Path write(Path path, String contents) throws IOException {
    Files.createDirectories(path.getParent());
    Files.write(path, contents.getBytes(StandardCharsets.UTF_8));
    return path;
  }

  private static byte[] read(InputStream stream) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[64];
    int n;
    while ((n = stream.read(buffer)) > 0) {
      out.write(buffer, 0, n);
    }
    stream.close();
    return out.toByteArray();
  }

  private static MiniappOrigin.Response get(MiniappOrigin origin, String path, String method, String range) {
    return origin.respond(method, "https", origin.host, -1, null, path, range);
  }

  public static void main(String[] args) throws Exception {
    Path base = Files.createTempDirectory("miniapp-origin");
    try {
      write(base.resolve("secret.txt"), "secret outside the root");
      write(base.resolve("alphax/secret.txt"), "secret beside the root");
      write(base.resolve("alpha/index.html"), "<!doctype html><title>alpha</title>");
      write(base.resolve("alpha/ui/app.js"), "window.loaded = true");
      write(base.resolve("alpha/ui/data.json"), "{\"who\":\"alpha\"}");
      write(base.resolve("alpha/ui/with space+plus.txt"), "spaced");
      byte[] media = new byte[1000];
      for (int i = 0; i < media.length; i++) media[i] = (byte) (i % 251);
      Files.write(base.resolve("alpha/media.bin"), media);
      Files.createSymbolicLink(base.resolve("alpha/link-out"), Path.of("../secret.txt"));
      Files.createSymbolicLink(base.resolve("alpha/link-in"), Path.of("ui/data.json"));
      Files.createSymbolicLink(base.resolve("alpha/link-dir-out"), base);
      Files.createSymbolicLink(base.resolve("alpha/link-sibling"), base.resolve("alphax/secret.txt"));
      String root = base.resolve("alpha").toString();
      File canonicalRoot = new File(root).getCanonicalFile();

      // Hosts
      check("com.mentra.notes.miniapp.invalid".equals(MiniappOrigin.hostForPackage("com.mentra.notes")), "host for a package");
      check("com.my-site.app.miniapp.invalid".equals(MiniappOrigin.hostForPackage("com.my_site.app")), "write _ as -");
      for (String name : new String[] {null, "", "com", "Com.mentra.notes", "com.my-site.app", "com..notes", "1com.notes",
                                       "com._notes", "com.notes.", "com/notes.app"}) {
        check(MiniappOrigin.hostForPackage(name) == null, "no host for " + name);
      }
      String longLabel = "a" + "b".repeat(63);
      check(MiniappOrigin.hostForPackage("com." + longLabel) == null, "no host with a label over 63 characters");
      check(MiniappOrigin.hostForPackage("com." + "b".repeat(63)) != null, "a 63-character label fits");
      String longName = "com" + ".abcdefghij".repeat(23);
      check(MiniappOrigin.hostForPackage(longName) == null, "no host over 253 characters");

      MiniappOrigin origin = new MiniappOrigin("com.test.alpha", root);
      check("com.test.alpha.miniapp.invalid".equals(origin.host), "the origin's host");
      check(origin.handles("https", "com.test.alpha.miniapp.invalid"), "handle its own host");
      check(origin.handles("https", "com.test.beta.miniapp.invalid"), "handle (refuse) another package's host");
      check(origin.handles("http", "COM.TEST.ALPHA.MINIAPP.INVALID"), "handle any *.miniapp.invalid request");
      check(origin.handles("file", null), "handle (refuse) file URLs");
      check(origin.handles("content", "media"), "handle (refuse) content URLs");
      check(!origin.handles("https", "api.example.com"), "pass other hosts to the network");
      check(!origin.handles("https", "miniapp.invalid.example.com"), "pass look-alike hosts to the network");

      // Resolution
      check(new File(canonicalRoot, "index.html").equals(origin.resolve("https", origin.host, -1, null, "/index.html")),
          "serve a file at the root");
      check(origin.resolve("https", "COM.TEST.ALPHA.miniapp.invalid", -1, null, "/index.html") != null, "hosts are case-insensitive");
      check(origin.resolve("https", origin.host, -1, null, "/ui/data.json").getPath().endsWith("/alpha/ui/data.json"), "serve a nested file");
      check(origin.resolve("https", origin.host, -1, null, "/ui/with%20space+plus.txt").getName().equals("with space+plus.txt"),
          "decode escapes, keeping +");
      check(origin.resolve("https", origin.host, -1, null, "/link-in").getPath().endsWith("/alpha/ui/data.json"),
          "follow a symlink that stays inside the root");
      check(new MiniappOrigin("com.test.alpha", canonicalRoot.toURI().toString()).resolve("https", origin.host, -1, null, "/index.html") != null,
          "accept the root as a file:// URL");
      String[] refused = {
        "/", "/ui", "/missing.html", "/ui/../index.html", "/ui/./data.json", "/ui/%2e%2e/index.html", "/%2E%2E/secret.txt",
        "/ui%2Fdata.json", "/ui%2fdata.json", "/ui%5Cdata.json", "/ui\\data.json", "/index.html%00.png", "/bad%zzescape",
        "/bad%2", "/link-out", "/link-dir-out/secret.txt", "/link-sibling", "index.html", "",
      };
      for (String path : refused) {
        check(origin.resolve("https", origin.host, -1, null, path) == null, "refuse " + path);
      }
      check(origin.resolve("https", "com.test.beta.miniapp.invalid", -1, null, "/index.html") == null, "refuse another package's host");
      check(origin.resolve("http", origin.host, -1, null, "/index.html") == null, "refuse http");
      check(origin.resolve("https", origin.host, 8443, null, "/index.html") == null, "refuse a port");
      check(origin.resolve("https", origin.host, -1, "user", "/index.html") == null, "refuse credentials");
      check(new MiniappOrigin("com.test.alpha", base.resolve("missing").toString()).resolve("https", origin.host, -1, null, "/index.html") == null,
          "refuse everything when the root is missing");
      check(new MiniappOrigin("com.test.alpha", "alpha").resolve("https", origin.host, -1, null, "/index.html") == null,
          "refuse a relative root");
      check(new MiniappOrigin("Com.Test", root).resolve("https", "com.test.miniapp.invalid", -1, null, "/index.html") == null,
          "refuse everything for an invalid package name");

      // Responses
      MiniappOrigin.Response page = get(origin, "/index.html", "GET", null);
      check(page.statusCode == 200 && "OK".equals(page.reasonPhrase), "serve the page with 200");
      check("text/html".equals(page.mimeType) && "utf-8".equals(page.encoding), "label HTML as UTF-8");
      check("no-store".equals(page.headers.get("Cache-Control")), "never cache");
      check("nosniff".equals(page.headers.get("X-Content-Type-Options")), "no sniffing");
      check(!page.headers.containsKey("Access-Control-Allow-Origin"), "no CORS grant");
      byte[] pageBody = read(page.body);
      check(Long.parseLong(page.headers.get("Content-Length")) == pageBody.length && pageBody.length > 0, "Content-Length matches the body");
      check("text/javascript".equals(get(origin, "/ui/app.js", "GET", null).mimeType), "label JavaScript");
      check("application/wasm".equals(MiniappOrigin.contentType("a.WASM")), "label wasm");
      check("video/mp4".equals(MiniappOrigin.contentType("a.mp4")), "label video");
      check("application/octet-stream".equals(MiniappOrigin.contentType("a.unknown")), "label unknown files as bytes");
      MiniappOrigin.Response json = get(origin, "/ui/data.json", "GET", null);
      check("application/json".equals(json.mimeType) && "utf-8".equals(json.encoding), "label JSON as UTF-8");
      MiniappOrigin.Response image = get(origin, "/media.bin", "GET", null);
      check(image.encoding == null, "no charset for binary files");

      MiniappOrigin.Response missing = origin.respond("GET", "https", "com.test.beta.miniapp.invalid", -1, null, "/index.html", null);
      check(missing.statusCode == 404 && "no-store".equals(missing.headers.get("Cache-Control")), "404 another package's host");
      check(origin.respond("GET", "file", null, -1, null, base.resolve("secret.txt").toString(), null).statusCode == 404, "404 file URLs");
      check(get(origin, "/link-out", "GET", null).statusCode == 404, "404 a symlink out");

      MiniappOrigin.Response head = get(origin, "/index.html", "HEAD", null);
      check(head.statusCode == 200 && read(head.body).length == 0 && head.headers.get("Content-Length").equals(page.headers.get("Content-Length")),
          "HEAD sends headers only");
      MiniappOrigin.Response post = get(origin, "/index.html", "POST", null);
      check(post.statusCode == 405 && "GET, HEAD".equals(post.headers.get("Allow")), "405 other methods");

      MiniappOrigin.Response full = get(origin, "/media.bin", "GET", null);
      check(full.statusCode == 200 && Arrays.equals(read(full.body), media) && "bytes".equals(full.headers.get("Accept-Ranges")), "serve media whole");
      MiniappOrigin.Response slice = get(origin, "/media.bin", "GET", "bytes=10-19");
      check(slice.statusCode == 206 && "bytes 10-19/1000".equals(slice.headers.get("Content-Range"))
          && Arrays.equals(read(slice.body), Arrays.copyOfRange(media, 10, 20)) && "10".equals(slice.headers.get("Content-Length")),
          "serve a byte range");
      MiniappOrigin.Response tail = get(origin, "/media.bin", "GET", "bytes=-100");
      check(tail.statusCode == 206 && "bytes 900-999/1000".equals(tail.headers.get("Content-Range")) && read(tail.body).length == 100,
          "serve a suffix range");
      check(read(get(origin, "/media.bin", "GET", "bytes=990-").body).length == 10, "serve an open range");
      check(read(get(origin, "/media.bin", "GET", "bytes=995-5000").body).length == 5, "clamp a range past the end");
      MiniappOrigin.Response beyond = get(origin, "/media.bin", "GET", "bytes=1000-");
      check(beyond.statusCode == 416 && "bytes */1000".equals(beyond.headers.get("Content-Range")), "416 a range past the end");
      check(get(origin, "/media.bin", "GET", "bytes=0-1,5-6").statusCode == 200, "ignore several ranges");
      check(get(origin, "/media.bin", "GET", "items=0-1").statusCode == 200, "ignore other range units");
    } finally {
      try (Stream<Path> paths = Files.walk(base)) {
        paths.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
      }
    }
    if (failures > 0) {
      System.err.println(failures + " check(s) failed");
      System.exit(1);
    }
    System.out.println("PASS: miniapp origin (Android)");
  }
}
