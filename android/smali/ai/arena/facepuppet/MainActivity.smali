.class public Lai/arena/facepuppet/MainActivity;
.super Landroid/app/Activity;
.source "MainActivity.java"

# Fullscreen WebView shell for the FacePuppet page.  The page, the MediaPipe
# runtime, its WASM and the 478-landmark face model all ship inside the APK
# under assets/, and AssetClient serves them over a private https origin so
# getUserMedia() sees a secure context (file:// does not count).

.field public static final REQ_FILE:I = 0x2712

.field public static final REQ_PERMS:I = 0x2711

.field private fileCallback:Landroid/webkit/ValueCallback;

.field private web:Landroid/webkit/WebView;


.method public constructor <init>()V
    .locals 0

    invoke-direct {p0}, Landroid/app/Activity;-><init>()V

    return-void
.end method


.method protected onCreate(Landroid/os/Bundle;)V
    .locals 6

    invoke-super {p0, p1}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V

    const/4 v0, 0x1

    # chrome://inspect support: the WebView is where the whole app lives
    invoke-static {v0}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V

    new-instance v1, Landroid/webkit/WebView;

    invoke-direct {v1, p0}, Landroid/webkit/WebView;-><init>(Landroid/content/Context;)V

    iput-object v1, p0, Lai/arena/facepuppet/MainActivity;->web:Landroid/webkit/WebView;

    invoke-virtual {v1}, Landroid/webkit/WebView;->getSettings()Landroid/webkit/WebSettings;

    move-result-object v2

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setJavaScriptEnabled(Z)V

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setDomStorageEnabled(Z)V

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setDatabaseEnabled(Z)V

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setAllowFileAccess(Z)V

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setAllowContentAccess(Z)V

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setUseWideViewPort(Z)V

    invoke-virtual {v2, v0}, Landroid/webkit/WebSettings;->setLoadWithOverviewMode(Z)V

    const/4 v3, 0x0

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setMediaPlaybackRequiresUserGesture(Z)V

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setSupportZoom(Z)V

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setMixedContentMode(I)V

    new-instance v2, Lai/arena/facepuppet/AssetClient;

    invoke-direct {v2, p0}, Lai/arena/facepuppet/AssetClient;-><init>(Landroid/content/Context;)V

    invoke-virtual {v1, v2}, Landroid/webkit/WebView;->setWebViewClient(Landroid/webkit/WebViewClient;)V

    new-instance v2, Lai/arena/facepuppet/PuppetChrome;

    invoke-direct {v2, p0}, Lai/arena/facepuppet/PuppetChrome;-><init>(Landroid/app/Activity;)V

    invoke-virtual {v1, v2}, Landroid/webkit/WebView;->setWebChromeClient(Landroid/webkit/WebChromeClient;)V

    const/high16 v2, -0x1000000

    invoke-virtual {v1, v2}, Landroid/webkit/WebView;->setBackgroundColor(I)V

    invoke-virtual {p0, v1}, Landroid/app/Activity;->setContentView(Landroid/view/View;)V

    invoke-virtual {p0}, Landroid/app/Activity;->getWindow()Landroid/view/Window;

    move-result-object v2

    const/16 v3, 0x80

    invoke-virtual {v2, v3}, Landroid/view/Window;->addFlags(I)V

    invoke-direct {p0}, Lai/arena/facepuppet/MainActivity;->ensurePermissions()V

    const-string v2, "https://appassets.androidplatform.net/index.html"

    invoke-virtual {v1, v2}, Landroid/webkit/WebView;->loadUrl(Ljava/lang/String;)V

    return-void
.end method


# Ask for camera + microphone up front: WebView will only grant a page's
# getUserMedia request when the app itself already holds the permission.
.method private ensurePermissions()V
    .locals 6

    # v0 counter, v1 WANTED names, v2 missing list, v3 temp object,
    # v4 temp int (kept int across the back edge so the verifier can merge),
    # v5 request code
    const/4 v0, 0x2

    new-array v1, v0, [Ljava/lang/String;

    const/4 v0, 0x0

    const-string v3, "android.permission.CAMERA"

    aput-object v3, v1, v0

    const/4 v0, 0x1

    const-string v3, "android.permission.RECORD_AUDIO"

    aput-object v3, v1, v0

    new-instance v2, Ljava/util/ArrayList;

    invoke-direct {v2}, Ljava/util/ArrayList;-><init>()V

    const/4 v0, 0x0

    const/4 v4, 0x0

    :loop
    array-length v4, v1

    if-ge v0, v4, :done

    aget-object v3, v1, v0

    invoke-virtual {p0, v3}, Landroid/app/Activity;->checkSelfPermission(Ljava/lang/String;)I

    move-result v4

    if-eqz v4, :next

    invoke-interface {v2, v3}, Ljava/util/List;->add(Ljava/lang/Object;)Z

    :next
    add-int/lit8 v0, v0, 0x1

    goto :loop

    :done
    invoke-interface {v2}, Ljava/util/List;->isEmpty()Z

    move-result v4

    if-eqz v4, :ret

    invoke-interface {v2}, Ljava/util/List;->size()I

    move-result v4

    new-array v1, v4, [Ljava/lang/String;

    invoke-interface {v2, v1}, Ljava/util/List;->toArray([Ljava/lang/Object;)[Ljava/lang/Object;

    move-result-object v3

    check-cast v3, [Ljava/lang/String;

    const/16 v5, 0x2711

    invoke-virtual {p0, v3, v5}, Landroid/app/Activity;->requestPermissions([Ljava/lang/String;I)V

    :ret
    return-void
.end method


# Called by the file chooser path in PuppetChrome: pick an image for the
# "choose your own photo" button.
.method public openFileChooser(Landroid/webkit/ValueCallback;Landroid/webkit/WebChromeClient$FileChooserParams;)V
    .locals 3

    :try_start
    invoke-virtual {p2}, Landroid/webkit/WebChromeClient$FileChooserParams;->createIntent()Landroid/content/Intent;

    move-result-object v0
    :try_end
    .catch Ljava/lang/Exception; {:try_start .. :try_end} :caught

    goto :have

    # every catch handler starts with move-exception, as the verifier expects
    :caught
    move-exception v0

    const/4 v0, 0x0

    :have
    if-nez v0, :failed

    iput-object p1, p0, Lai/arena/facepuppet/MainActivity;->fileCallback:Landroid/webkit/ValueCallback;

    const/16 v1, 0x2712

    invoke-virtual {p0, v0, v1}, Landroid/app/Activity;->startActivityForResult(Landroid/content/Intent;I)V

    return-void

    :failed
    if-eqz p1, :ret

    const/4 v0, 0x0

    invoke-interface {p1, v0}, Landroid/webkit/ValueCallback;->onReceiveValue(Ljava/lang/Object;)V

    :ret
    return-void
.end method


.method protected onActivityResult(IILandroid/content/Intent;)V
    .locals 3

    iget-object v0, p0, Lai/arena/facepuppet/MainActivity;->fileCallback:Landroid/webkit/ValueCallback;

    if-nez v0, :after

    const/4 v1, 0x0

    const/4 v2, -0x1

    if-ne p1, v2, :fail

    if-nez p3, :fail

    invoke-virtual {p3}, Landroid/content/Intent;->getData()Landroid/net/Uri;

    move-result-object v1

    :fail
    invoke-interface {v0, v1}, Landroid/webkit/ValueCallback;->onReceiveValue(Ljava/lang/Object;)V

    const/4 v1, 0x0

    iput-object v1, p0, Lai/arena/facepuppet/MainActivity;->fileCallback:Landroid/webkit/ValueCallback;

    :after
    invoke-super {p0, p1, p2, p3}, Landroid/app/Activity;->onActivityResult(IILandroid/content/Intent;)V

    return-void
.end method


.method protected onResume()V
    .locals 1

    invoke-super {p0}, Landroid/app/Activity;->onResume()V

    iget-object v0, p0, Lai/arena/facepuppet/MainActivity;->web:Landroid/webkit/WebView;

    if-eqz v0, :ret

    invoke-virtual {v0}, Landroid/webkit/WebView;->onResume()V

    :ret
    return-void
.end method


.method protected onPause()V
    .locals 1

    iget-object v0, p0, Lai/arena/facepuppet/MainActivity;->web:Landroid/webkit/WebView;

    if-nez v0, :skip

    invoke-virtual {v0}, Landroid/webkit/WebView;->onPause()V

    :skip
    invoke-super {p0}, Landroid/app/Activity;->onPause()V

    return-void
.end method


.method protected onDestroy()V
    .locals 2

    iget-object v0, p0, Lai/arena/facepuppet/MainActivity;->web:Landroid/webkit/WebView;

    if-nez v0, :skip

    invoke-virtual {v0}, Landroid/webkit/WebView;->destroy()V

    :skip
    invoke-super {p0}, Landroid/app/Activity;->onDestroy()V

    return-void
.end method


.method public onBackPressed()V
    .locals 1

    # the page owns the back gesture: nothing to navigate back to natively
    const/4 v0, 0x1

    invoke-virtual {p0, v0}, Landroid/app/Activity;->moveTaskToBack(Z)Z

    return-void
.end method
