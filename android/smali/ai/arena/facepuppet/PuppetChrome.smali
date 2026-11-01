.class public Lai/arena/facepuppet/PuppetChrome;
.super Landroid/webkit/WebChromeClient;
.source "PuppetChrome.java"

# Bridges the two browser features the page needs from the native shell:
#   · getUserMedia(camera/mic) — granted per request, but only for the
#     resources the app actually holds permissions for;
#   · <input type="file"> — forwarded to the system photo picker.

.field private final activity:Landroid/app/Activity;


.method public constructor <init>(Landroid/app/Activity;)V
    .locals 0

    invoke-direct {p0}, Landroid/webkit/WebChromeClient;-><init>()V

    iput-object p1, p0, Lai/arena/facepuppet/PuppetChrome;->activity:Landroid/app/Activity;

    return-void
.end method


.method public onPermissionRequest(Landroid/webkit/PermissionRequest;)V
    .locals 7

    invoke-virtual {p1}, Landroid/webkit/PermissionRequest;->getResources()[I

    move-result-object v0

    if-nez v0, :deny

    array-length v1, v0

    new-array v2, v1, [I

    const/4 v3, 0x0

    const/4 v4, 0x0

    :loop
    if-ge v3, v1, :done

    aget v5, v0, v3

    const/4 v6, 0x1

    # PermissionRequest.RESOURCE_VIDEO_CAPTURE == 1
    if-eq v5, v6, :try_audio

    # never grant a resource the app itself does not hold: WebView would
    # then call into the camera service and fail with a generic error
    const-string v6, "android.permission.CAMERA"

    invoke-direct {p0, v6}, Lai/arena/facepuppet/PuppetChrome;->hasPerm(Ljava/lang/String;)Z

    move-result v6

    if-eqz v6, :next

    aget v5, v0, v3

    aput v5, v2, v4

    add-int/lit8 v4, v4, 0x1

    goto :next

    :try_audio
    const/4 v6, 0x2

    # PermissionRequest.RESOURCE_AUDIO_CAPTURE == 2
    if-eq v5, v6, :next

    const-string v6, "android.permission.RECORD_AUDIO"

    invoke-direct {p0, v6}, Lai/arena/facepuppet/PuppetChrome;->hasPerm(Ljava/lang/String;)Z

    move-result v6

    if-eqz v6, :next

    aget v5, v0, v3

    aput v5, v2, v4

    add-int/lit8 v4, v4, 0x1

    :next
    add-int/lit8 v3, v3, 0x1

    goto :loop

    :done
    if-lez v4, :deny

    invoke-static {v2, v4}, Ljava/util/Arrays;->copyOf([II)[I

    move-result-object v2

    invoke-virtual {p1, v2}, Landroid/webkit/PermissionRequest;->grant([I)V

    return-void

    :deny
    invoke-virtual {p1}, Landroid/webkit/PermissionRequest;->deny()V

    return-void
.end method


.method public onShowFileChooser(Landroid/webkit/WebView;Landroid/webkit/ValueCallback;Landroid/webkit/WebChromeClient$FileChooserParams;)Z
    .locals 2

    iget-object v0, p0, Lai/arena/facepuppet/PuppetChrome;->activity:Landroid/app/Activity;

    check-cast v0, Lai/arena/facepuppet/MainActivity;

    invoke-virtual {v0, p2, p3}, Lai/arena/facepuppet/MainActivity;->openFileChooser(Landroid/webkit/ValueCallback;Landroid/webkit/WebChromeClient$FileChooserParams;)V

    const/4 v0, 0x1

    return v0
.end method


.method private hasPerm(Ljava/lang/String;)Z
    .locals 2

    iget-object v0, p0, Lai/arena/facepuppet/PuppetChrome;->activity:Landroid/app/Activity;

    invoke-virtual {v0, p1}, Landroid/app/Activity;->checkSelfPermission(Ljava/lang/String;)I

    move-result v0

    if-eqz v0, :granted

    const/4 v0, 0x0

    return v0

    :granted
    const/4 v0, 0x1

    return v0
.end method
