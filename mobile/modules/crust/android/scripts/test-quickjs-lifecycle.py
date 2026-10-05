#!/usr/bin/env python3
"""Compile and test real JNI on Linux; run only when native builds are authorized."""
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

android = Path(__file__).resolve().parents[1]
cache = Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))) / "caches/modules-2/files-2.1"


def artifact(group, name, version, extension="jar"):
    # Classifier artifacts such as -sources.jar share the version directory.
    matches = [path for path in (cache / group / name / version).glob(f"*/*.{extension}")
               if not path.stem.endswith(("-sources", "-javadoc"))]
    if not matches:
        raise SystemExit(f"Missing cached {group}:{name}:{version}; resolve Android dependencies first.")
    return matches[0]


with tempfile.TemporaryDirectory(prefix="mentra-quickjs-test-") as directory:
    output = Path(directory)
    native = output / "native"
    subprocess.run(["cmake", "-S", str(android / "src/main/cpp/quickjs"), "-B", str(native),
                    "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"], check=True)
    subprocess.run(["cmake", "--build", str(native), "-j", "2"], check=True)
    aar = artifact("io.github.dokar3", "quickjs-kt-android", "1.0.0-alpha13", "aar")
    with zipfile.ZipFile(aar) as archive:
        (output / "quickjs.jar").write_bytes(archive.read("classes.jar"))
    runtime = [output / "quickjs.jar",
               artifact("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20"),
               artifact("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.1"),
               artifact("androidx.annotation", "annotation-jvm", "1.9.1"),
               artifact("org.jetbrains", "annotations", "23.0.0")]
    compiler = runtime + [artifact("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.1.20"),
                          artifact("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330")]
    classpath = os.pathsep.join(map(str, runtime))
    subprocess.run(["java", "-cp", os.pathsep.join(map(str, compiler)),
                    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
                    "-jvm-target", "17", "-classpath", classpath, "-d", str(output / "classes"),
                    str(android / "src/testNative/QuickJsLifecycleTest.kt")], check=True)
    subprocess.run(["java", f"-Djava.library.path={native}", "-cp",
                    str(output / "classes") + os.pathsep + classpath,
                    "com.mentra.crust.jsc.QuickJsLifecycleTestKt"], check=True, timeout=30)
