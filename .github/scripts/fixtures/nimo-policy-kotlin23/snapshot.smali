.class public final Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;
.super Ljava/lang/Object;
.source "Policy.kt"


# annotations
.annotation system Ldalvik/annotation/MemberClasses;
    value = {
        Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;
    }
.end annotation

.annotation runtime Lkotlin/Metadata;
    d1 = {
        "\u0000.\n\u0002\u0018\u0002\n\u0002\u0010\u0000\n\u0002\u0008\u0003\n\u0002\u0010\u000b\n\u0000\n\u0002\u0010\u000e\n\u0002\u0008\n\n\u0002\u0018\u0002\n\u0000\n\u0002\u0018\u0002\n\u0000\n\u0002\u0010\t\n\u0002\u0008\u0003\u0008\u00c0\u0002\u0018\u00002\u00020\u0001:\u0001\u0018B\t\u0008\u0002\u00a2\u0006\u0004\u0008\u0002\u0010\u0003J\u0017\u0010\u0004\u001a\u00020\u00052\u0008\u0008\u0002\u0010\u0006\u001a\u00020\u0007H\u0000\u00a2\u0006\u0002\u0008\u0008J\u001d\u0010\t\u001a\u00020\u00052\u0006\u0010\u0006\u001a\u00020\u00072\u0006\u0010\n\u001a\u00020\u0007H\u0000\u00a2\u0006\u0002\u0008\u000bJ\u001a\u0010\u000c\u001a\u00020\u00052\u0006\u0010\n\u001a\u00020\u00072\n\u0008\u0002\u0010\r\u001a\u0004\u0018\u00010\u0007J\u0006\u0010\u000e\u001a\u00020\u0005J!\u0010\u0011\u001a\u00020\u00122\u0006\u0010\u0013\u001a\u00020\u00142\n\u0008\u0002\u0010\u0015\u001a\u0004\u0018\u00010\u0016H\u0002\u00a2\u0006\u0002\u0010\u0017R\u000e\u0010\u000f\u001a\u00020\u0007X\u0086T\u00a2\u0006\u0002\n\u0000R\u000e\u0010\u0010\u001a\u00020\u0007X\u0082D\u00a2\u0006\u0002\n\u0000\u00a8\u0006\u0019"
    }
    d2 = {
        "Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;",
        "",
        "<init>",
        "()V",
        "preArmCaptureRequired",
        "",
        "buildType",
        "",
        "preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic",
        "allowUnarmedWearable",
        "wearable",
        "allowUnarmedWearable$bluetooth_sdk_nimoDiagnostic",
        "allowManagerConnect",
        "name",
        "admit",
        "CLOCK_PROTOCOL",
        "processInstanceId",
        "captureSnapshot",
        "Lorg/json/JSONObject;",
        "owned",
        "Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;",
        "admittedElapsedMs",
        "",
        "(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;Ljava/lang/Long;)Lorg/json/JSONObject;",
        "Capture",
        "bluetooth_sdk_nimoDiagnostic"
    }
    k = 0x1
    mv = {
        0x2,
        0x3,
        0x0
    }
    xi = 0x30
.end annotation


# static fields
.field public static final CLOCK_PROTOCOL:Ljava/lang/String; = "nimo-monotonic-receipt-v1"
    .annotation build Lorg/jetbrains/annotations/NotNull;
    .end annotation
.end field

.field public static final INSTANCE:Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;
    .annotation build Lorg/jetbrains/annotations/NotNull;
    .end annotation
.end field

.field private static final processInstanceId:Ljava/lang/String;
    .annotation build Lorg/jetbrains/annotations/NotNull;
    .end annotation
.end field


# direct methods
.method static constructor <clinit>()V
    .registers 1

    new-instance v0, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;

    invoke-direct {v0}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;-><init>()V

    sput-object v0, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->INSTANCE:Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;

    .line 12
    const-string v0, "sample"

    sput-object v0, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->processInstanceId:Ljava/lang/String;

    return-void
.end method

.method private constructor <init>()V
    .registers 1

    .line 5
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method

.method public static synthetic allowManagerConnect$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Ljava/lang/String;Ljava/lang/String;ILjava/lang/Object;)Z
    .registers 5

    .line 8
    and-int/lit8 p3, p3, 0x2

    if-eqz p3, :cond_5

    const/4 p2, 0x0

    :cond_5
    invoke-virtual {p0, p1, p2}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z

    move-result p0

    return p0
.end method

.method private final captureSnapshot(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;Ljava/lang/Long;)Lorg/json/JSONObject;
    .registers 8
    .param p1, "owned"    # Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;
    .param p2, "admittedElapsedMs"    # Ljava/lang/Long;

    .line 14
    new-instance v0, Lorg/json/JSONObject;

    invoke-direct {v0}, Lorg/json/JSONObject;-><init>()V

    .line 15
    const-string v1, "clockProtocol"

    const-string v2, "nimo-monotonic-receipt-v1"

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 16
    new-instance v1, Lorg/json/JSONObject;

    invoke-direct {v1}, Lorg/json/JSONObject;-><init>()V

    const-string v2, "kind"

    const-string v3, "android-elapsed-realtime-v1"

    invoke-virtual {v1, v2, v3}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v1

    const-string v2, "armedElapsedMs"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getArmedElapsedMs()J

    move-result-wide v3

    invoke-virtual {v1, v2, v3, v4}, Lorg/json/JSONObject;->put(Ljava/lang/String;J)Lorg/json/JSONObject;

    move-result-object v1

    .line 17
    if-nez p2, :cond_29

    sget-object v2, Lorg/json/JSONObject;->NULL:Ljava/lang/Object;

    goto :goto_2a

    :cond_29
    move-object v2, p2

    :goto_2a
    const-string v3, "admittedElapsedMs"

    invoke-virtual {v1, v3, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v1

    const-string v2, "observedElapsedMs"

    invoke-static {}, Landroid/os/SystemClock;->elapsedRealtime()J

    move-result-wide v3

    invoke-virtual {v1, v2, v3, v4}, Lorg/json/JSONObject;->put(Ljava/lang/String;J)Lorg/json/JSONObject;

    move-result-object v1

    .line 16
    const-string v2, "clock"

    invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 18
    const-string v1, "version"

    const-string v2, "nimo-preconnect-capture-v1"

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    const-string v1, "nonce"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getNonce()Ljava/lang/String;

    move-result-object v2

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 19
    const/4 v1, 0x1

    const/4 v2, 0x0

    invoke-static {p0, v2, v1, v2}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Ljava/lang/String;ILjava/lang/Object;)Z

    move-result v1

    const-string v2, "captureRequiredBeforeArm"

    invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;

    move-result-object v0

    .line 20
    new-instance v1, Lorg/json/JSONObject;

    invoke-direct {v1}, Lorg/json/JSONObject;-><init>()V

    const-string v2, "name"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getName()Ljava/lang/String;

    move-result-object v3

    invoke-virtual {v1, v2, v3}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v1

    const-string v2, "bluetoothAddress"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getAddress()Ljava/lang/String;

    move-result-object v3

    invoke-virtual {v1, v2, v3}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v1

    const-string v2, "expectedPair"

    invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 21
    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getInstance()Lcom/mentra/bluetoothsdk/sgcs/Nimo;

    move-result-object v1

    if-eqz v1, :cond_89

    invoke-virtual {v1}, Lcom/mentra/bluetoothsdk/sgcs/Nimo;->getResourceInstanceId()Ljava/lang/String;

    move-result-object v1

    if-nez v1, :cond_8b

    :cond_89
    sget-object v1, Lorg/json/JSONObject;->NULL:Ljava/lang/Object;

    :cond_8b
    const-string v2, "instanceId"

    invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 22
    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getInstance()Lcom/mentra/bluetoothsdk/sgcs/Nimo;

    move-result-object v1

    const-string v2, "sessionGeneration"

    if-eqz v1, :cond_a8

    invoke-virtual {v1}, Lcom/mentra/bluetoothsdk/sgcs/Nimo;->resourceSnapshot()Lorg/json/JSONObject;

    move-result-object v1

    if-eqz v1, :cond_a8

    invoke-virtual {v1, v2}, Lorg/json/JSONObject;->getLong(Ljava/lang/String;)J

    move-result-wide v3

    invoke-static {v3, v4}, Ljava/lang/Long;->valueOf(J)Ljava/lang/Long;

    move-result-object v1

    goto :goto_aa

    :cond_a8
    sget-object v1, Lorg/json/JSONObject;->NULL:Ljava/lang/Object;

    :goto_aa
    invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 23
    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getTransportStarted()Z

    move-result v1

    if-eqz v1, :cond_c8

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getInstance()Lcom/mentra/bluetoothsdk/sgcs/Nimo;

    move-result-object v1

    if-eqz v1, :cond_c8

    invoke-virtual {v1}, Lcom/mentra/bluetoothsdk/sgcs/Nimo;->resourceSnapshot()Lorg/json/JSONObject;

    move-result-object v1

    if-eqz v1, :cond_c8

    const-string v2, "pair"

    invoke-virtual {v1, v2}, Lorg/json/JSONObject;->getJSONObject(Ljava/lang/String;)Lorg/json/JSONObject;

    move-result-object v1

    if-nez v1, :cond_ca

    :cond_c8
    sget-object v1, Lorg/json/JSONObject;->NULL:Ljava/lang/Object;

    :cond_ca
    const-string v2, "observedPair"

    invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 24
    const-string v1, "cancelled"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getCancelled()Z

    move-result v2

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;

    move-result-object v0

    const-string v1, "connectStarted"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getConnectStarted()Z

    move-result v2

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;

    move-result-object v0

    .line 25
    const-string v1, "transportStarted"

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getTransportStarted()Z

    move-result v2

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;

    move-result-object v0

    .line 26
    const-string v1, "appPid"

    invoke-static {}, Landroid/os/Process;->myPid()I

    move-result v2

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;I)Lorg/json/JSONObject;

    move-result-object v0

    const-string v1, "processInstanceId"

    sget-object v2, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->processInstanceId:Ljava/lang/String;

    invoke-virtual {v0, v1, v2}, Lorg/json/JSONObject;->put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;

    move-result-object v0

    .line 27
    const-string v1, "observedAtEpochMs"

    invoke-static {}, Ljava/lang/System;->currentTimeMillis()J

    move-result-wide v2

    invoke-virtual {v0, v1, v2, v3}, Lorg/json/JSONObject;->put(Ljava/lang/String;J)Lorg/json/JSONObject;

    move-result-object v0

    return-object v0
.end method

.method static synthetic captureSnapshot$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;Ljava/lang/Long;ILjava/lang/Object;)Lorg/json/JSONObject;
    .registers 5

    .line 14
    and-int/lit8 p3, p3, 0x2

    if-eqz p3, :cond_8

    invoke-virtual {p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;->getAdmittedElapsedMs()Ljava/lang/Long;

    move-result-object p2

    :cond_8
    invoke-direct {p0, p1, p2}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->captureSnapshot(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;Ljava/lang/Long;)Lorg/json/JSONObject;

    move-result-object p0

    return-object p0
.end method

.method public static synthetic preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Ljava/lang/String;ILjava/lang/Object;)Z
    .registers 4

    .line 6
    and-int/lit8 p2, p2, 0x1

    if-eqz p2, :cond_6

    const-string p1, "nimoDiagnostic"

    :cond_6
    invoke-virtual {p0, p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;)Z

    move-result p0

    return p0
.end method


# virtual methods
.method public final admit()Z
    .registers 3

    .line 9
    const/4 v0, 0x0

    const/4 v1, 0x1

    invoke-static {p0, v0, v1, v0}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Ljava/lang/String;ILjava/lang/Object;)Z

    move-result v0

    xor-int/2addr v0, v1

    return v0
.end method

.method public final allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z
    .registers 4
    .param p1, "wearable"    # Ljava/lang/String;
        .annotation build Lorg/jetbrains/annotations/NotNull;
        .end annotation
    .end param
    .param p2, "name"    # Ljava/lang/String;
        .annotation build Lorg/jetbrains/annotations/Nullable;
        .end annotation
    .end param

    const-string v0, "wearable"

    invoke-static {p1, v0}, Lkotlin/jvm/internal/Intrinsics;->checkNotNullParameter(Ljava/lang/Object;Ljava/lang/String;)V

    .line 8
    const-string v0, "nimoDiagnostic"

    invoke-virtual {p0, v0, p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->allowUnarmedWearable$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;Ljava/lang/String;)Z

    move-result v0

    return v0
.end method

.method public final allowUnarmedWearable$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;Ljava/lang/String;)Z
    .registers 6
    .param p1, "buildType"    # Ljava/lang/String;
        .annotation build Lorg/jetbrains/annotations/NotNull;
        .end annotation
    .end param
    .param p2, "wearable"    # Ljava/lang/String;
        .annotation build Lorg/jetbrains/annotations/NotNull;
        .end annotation
    .end param

    const-string v0, "buildType"

    invoke-static {p1, v0}, Lkotlin/jvm/internal/Intrinsics;->checkNotNullParameter(Ljava/lang/Object;Ljava/lang/String;)V

    const-string v0, "wearable"

    invoke-static {p2, v0}, Lkotlin/jvm/internal/Intrinsics;->checkNotNullParameter(Ljava/lang/Object;Ljava/lang/String;)V

    .line 7
    invoke-virtual {p0, p1}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;)Z

    move-result v0

    const/4 v1, 0x1

    if-eqz v0, :cond_20

    move-object v0, p2

    check-cast v0, Ljava/lang/CharSequence;

    const-string v2, "NIMO"

    check-cast v2, Ljava/lang/CharSequence;

    invoke-static {v0, v2, v1}, Lkotlin/text/StringsKt;->contains(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Z)Z

    move-result v0

    if-nez v0, :cond_1f

    goto :goto_20

    :cond_1f
    const/4 v1, 0x0

    :cond_20
    :goto_20
    return v1
.end method

.method public final preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;)Z
    .registers 3
    .param p1, "buildType"    # Ljava/lang/String;
        .annotation build Lorg/jetbrains/annotations/NotNull;
        .end annotation
    .end param

    const-string v0, "buildType"

    invoke-static {p1, v0}, Lkotlin/jvm/internal/Intrinsics;->checkNotNullParameter(Ljava/lang/Object;Ljava/lang/String;)V

    .line 6
    const-string v0, "nimoDiagnostic"

    invoke-static {p1, v0}, Lkotlin/jvm/internal/Intrinsics;->areEqual(Ljava/lang/Object;Ljava/lang/Object;)Z

    move-result v0

    return v0
.end method

