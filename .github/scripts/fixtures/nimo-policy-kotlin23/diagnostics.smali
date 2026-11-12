.class public final Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;
.super Ljava/lang/Object;
.source "Policy.kt"


# annotations
.annotation runtime Lkotlin/Metadata;
    d1 = {
        "\u0000\u001a\n\u0002\u0018\u0002\n\u0002\u0010\u0000\n\u0002\u0008\u0003\n\u0002\u0010\u000b\n\u0000\n\u0002\u0010\u000e\n\u0002\u0008\u0008\u0008\u00c0\u0002\u0018\u00002\u00020\u0001B\t\u0008\u0002\u00a2\u0006\u0004\u0008\u0002\u0010\u0003J\u0017\u0010\u0004\u001a\u00020\u00052\u0008\u0008\u0002\u0010\u0006\u001a\u00020\u0007H\u0000\u00a2\u0006\u0002\u0008\u0008J\u001d\u0010\t\u001a\u00020\u00052\u0006\u0010\u0006\u001a\u00020\u00072\u0006\u0010\n\u001a\u00020\u0007H\u0000\u00a2\u0006\u0002\u0008\u000bJ\u001a\u0010\u000c\u001a\u00020\u00052\u0006\u0010\n\u001a\u00020\u00072\n\u0008\u0002\u0010\r\u001a\u0004\u0018\u00010\u0007J\u0006\u0010\u000e\u001a\u00020\u0005\u00a8\u0006\u000f"
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
.field public static final INSTANCE:Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;
    .annotation build Lorg/jetbrains/annotations/NotNull;
    .end annotation
.end field


# direct methods
.method static constructor <clinit>()V
    .registers 1

    new-instance v0, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;

    invoke-direct {v0}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;-><init>()V

    sput-object v0, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->INSTANCE:Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;

    return-void
.end method

.method private constructor <init>()V
    .registers 1

    .line 2
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method

.method public static synthetic allowManagerConnect$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Ljava/lang/String;Ljava/lang/String;ILjava/lang/Object;)Z
    .registers 5

    .line 5
    and-int/lit8 p3, p3, 0x2

    if-eqz p3, :cond_5

    const/4 p2, 0x0

    :cond_5
    invoke-virtual {p0, p1, p2}, Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;->allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z

    move-result p0

    return p0
.end method

.method public static synthetic preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic$default(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics;Ljava/lang/String;ILjava/lang/Object;)Z
    .registers 4

    .line 3
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

    .line 6
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

    .line 5
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

    .line 4
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

    .line 3
    const-string v0, "nimoDiagnostic"

    invoke-static {p1, v0}, Lkotlin/jvm/internal/Intrinsics;->areEqual(Ljava/lang/Object;Ljava/lang/Object;)Z

    move-result v0

    return v0
.end method

