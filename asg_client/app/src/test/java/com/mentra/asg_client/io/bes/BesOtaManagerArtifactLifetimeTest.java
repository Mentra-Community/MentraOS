package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator.ValidatedBesArtifact;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaManagerArtifactLifetimeTest {
    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void ephemeralArtifactSurvivesMetadataCommandsAndDeletesAfterApplyAck()
            throws Exception {
        File source = temporaryFolder.newFile("debug_bes.bin");
        byte[] bytes = new byte[512];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) (i * 31);
        }
        try (FileOutputStream output = new FileOutputStream(source)) {
            output.write(bytes);
        }

        BesOtaManager manager =
                new BesOtaManager(null, null, ApplicationProvider.getApplicationContext());
        ValidatedBesArtifact artifact = mock(ValidatedBesArtifact.class);
        when(artifact.getFile()).thenReturn(source);
        when(artifact.deleteSourceIfEphemeral())
                .thenAnswer(invocation -> !source.exists() || source.delete());
        setField(manager, "activeArtifact", artifact);

        assertThat(manager.init(source.getAbsolutePath())).isTrue();
        assertThat(manager.SCmd_SetStartInfo()).isNotNull();
        assertThat(manager.SCmd_SetConfig(false, null, null, null, null)).isNotNull();
        assertThat(source).exists();
        verify(artifact, never()).deleteSourceIfEphemeral();

        invokeNoArgs(manager, "releaseAfterApplyAcknowledgedLocked");

        verify(artifact).deleteSourceIfEphemeral();
        assertThat(source).doesNotExist();
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static void invokeNoArgs(Object target, String name) throws Exception {
        Method method = target.getClass().getDeclaredMethod(name);
        method.setAccessible(true);
        method.invoke(target);
    }
}
