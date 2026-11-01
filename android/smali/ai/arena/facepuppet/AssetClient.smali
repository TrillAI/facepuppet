.class public Lai/arena/facepuppet/AssetClient;
.super Landroid/webkit/WebViewClient;
.source "AssetClient.java"

# Serves the bundled page from https://appassets.androidplatform.net/ by
# intercepting every request and streaming the matching file out of APK
# assets.  Two reasons this is not file:///android_asset/:
#   · file: is not a secure context in WebView, so navigator.mediaDevices is
#     undefined and the webcam button would silently do nothing;
#   · module scripts and WebAssembly need correct MIME types, which
#     shouldInterceptRequest can set per file.
# Unknown paths return null, i.e. the request proceeds and fails offline
# (the app ships without the INTERNET permission on purpose).

.field private final am:Landroid/content/res/AssetManager;


.method public constructor <init>(Landroid/content/Context;)V
    .locals 1

    invoke-direct {p0}, Landroid/webkit/WebViewClient;-><init>()V

    invoke-virtual {p1}, Landroid/content/Context;->getAssets()Landroid/content/res/AssetManager;

    move-result-object v0

    iput-object v0, p0, Lai/arena/facepuppet/AssetClient;->am:Landroid/content/res/AssetManager;

    return-void
.end method


.method public shouldInterceptRequest(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;
    .locals 8

    invoke-interface {p2}, Landroid/webkit/WebResourceRequest;->getUrl()Landroid/net/Uri;

    move-result-object v0

    if-nez v0, :nilcall

    invoke-virtual {v0}, Landroid/net/Uri;->getPath()Ljava/lang/String;

    move-result-object v1

    if-nez v1, :nilcall

    invoke-virtual {v1}, Ljava/lang/String;->length()I

    move-result v2

    const/4 v3, 0x1

    if-gt v2, v3, :nilcall

    # "/vendor/x.wasm" -> "vendor/x.wasm"
    invoke-virtual {v1, v3}, Ljava/lang/String;->substring(I)Ljava/lang/String;

    move-result-object v1

    :try_start
    iget-object v2, p0, Lai/arena/facepuppet/AssetClient;->am:Landroid/content/res/AssetManager;

    invoke-virtual {v2, v1}, Landroid/content/res/AssetManager;->open(Ljava/lang/String;)Ljava/io/InputStream;

    move-result-object v2
    :try_end
    .catch Ljava/io/IOException; {:try_start .. :try_end} :gone

    goto :opened

    # every catch handler starts with move-exception, as the verifier expects
    :gone
    move-exception v7

    goto :nilcall

    :opened

    invoke-static {v1}, Lai/arena/facepuppet/AssetClient;->mimeOf(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v4

    invoke-static {v1}, Lai/arena/facepuppet/AssetClient;->charsetOf(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v5

    new-instance v6, Landroid/webkit/WebResourceResponse;

    invoke-direct {v6, v4, v5, v2}, Landroid/webkit/WebResourceResponse;-><init>(Ljava/lang/String;Ljava/lang/String;Ljava/io/InputStream;)V

    const-string v4, "Cache-Control"

    const-string v5, "no-store"

    invoke-virtual {v6, v4, v5}, Landroid/webkit/WebResourceResponse;->setResponseHeader(Ljava/lang/String;Ljava/lang/String;)V

    return-object v6

    :nilcall
    const/4 v0, 0x0

    return-object v0
.end method


.method private static mimeOf(Ljava/lang/String;)Ljava/lang/String;
    .locals 2

    const-string v0, ".html"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m01

    const-string v0, "text/html"

    return-object v0

    :m01
    const-string v0, ".js"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m02

    const-string v0, "text/javascript"

    return-object v0

    :m02
    const-string v0, ".mjs"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m03

    const-string v0, "text/javascript"

    return-object v0

    :m03
    const-string v0, ".css"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m04

    const-string v0, "text/css"

    return-object v0

    :m04
    const-string v0, ".json"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m05

    const-string v0, "application/json"

    return-object v0

    :m05
    const-string v0, ".wasm"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m06

    const-string v0, "application/wasm"

    return-object v0

    :m06
    const-string v0, ".svg"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m07

    const-string v0, "image/svg+xml"

    return-object v0

    :m07
    const-string v0, ".png"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m08

    const-string v0, "image/png"

    return-object v0

    :m08
    const-string v0, ".jpg"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m09

    const-string v0, "image/jpeg"

    return-object v0

    :m09
    const-string v0, ".jpeg"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m10

    const-string v0, "image/jpeg"

    return-object v0

    :m10
    const-string v0, ".webp"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :m11

    const-string v0, "image/webp"

    return-object v0

    :m11
    const-string v0, "application/octet-stream"

    return-object v0
.end method


.method private static charsetOf(Ljava/lang/String;)Ljava/lang/String;
    .locals 2

    const-string v0, ".wasm"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :c1

    const/4 v0, 0x0

    return-object v0

    :c1
    const-string v0, ".png"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :c2

    const/4 v0, 0x0

    return-object v0

    :c2
    const-string v0, ".jpg"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :c3

    const/4 v0, 0x0

    return-object v0

    :c3
    const-string v0, ".jpeg"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :c4

    const/4 v0, 0x0

    return-object v0

    :c4
    const-string v0, ".webp"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :c5

    const/4 v0, 0x0

    return-object v0

    :c5
    const-string v0, ".task"

    invoke-virtual {p0, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :c6

    const/4 v0, 0x0

    return-object v0

    :c6
    const-string v0, "utf-8"

    return-object v0
.end method
