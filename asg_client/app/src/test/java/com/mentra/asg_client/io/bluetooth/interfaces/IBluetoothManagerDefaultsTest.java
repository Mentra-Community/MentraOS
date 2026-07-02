package com.mentra.asg_client.io.bluetooth.interfaces;

import static org.assertj.core.api.Assertions.assertThatCode;

import org.junit.Test;

/**
 * Proves the four transport-level hooks on {@link IBluetoothManager} are safe no-ops by default,
 * so non-K900 transports (e.g. {@code StandardBluetoothManager}) need no changes.
 */
public class IBluetoothManagerDefaultsTest {

    /** Minimal transport implementing only the abstract methods — inherits all defaults. */
    private static final class MinimalTransport implements ICompanionTransport {
        @Override
        public void initialize() {}

        @Override
        public void startAdvertising() {}

        @Override
        public void stopAdvertising() {}

        @Override
        public boolean isConnected() {
            return false;
        }

        @Override
        public void disconnect() {}

        @Override
        public boolean sendMessage(byte[] data) {
            return false;
        }

        @Override
        public boolean sendMessage(byte[] data, IBluetoothManager.SendMessageCallback callback) {
            return false;
        }

        @Override
        public boolean sendMessage(
                byte[] data,
                IBluetoothManager.SendMessageCallback callback,
                IBluetoothManager.SendMessageGate gate) {
            return false;
        }

        @Override
        public boolean sendFile(String filePath) {
            return false;
        }

        @Override
        public boolean isFileTransferInProgress() {
            return false;
        }

        @Override
        public void addBluetoothListener(TransportListener listener) {}

        @Override
        public void removeBluetoothListener(TransportListener listener) {}

        @Override
        public void shutdown() {}
    }

    @Test
    public void defaultTransportHooks_areNoOpsAndDoNotThrow() {
        ICompanionTransport transport = new MinimalTransport();

        assertThatCode(
                        () -> {
                            transport.onMtuNegotiated(251);
                            transport.onTransportReset();
                            transport.onFileTransferConfirmation("photo.jpg", true);
                            transport.onFileTransferAck(1, 7);
                        })
                .doesNotThrowAnyException();
    }
}
