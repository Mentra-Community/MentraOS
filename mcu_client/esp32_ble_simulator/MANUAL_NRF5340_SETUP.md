# Manual nRF5340 BLE Project Setup using nRF Connect VS Code Extension

## Prerequisites Setup

### Step 1: Install nRF Connect for Desktop
1. Download from: https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-Desktop
2. Install the .dmg file for macOS
3. Open nRF Connect for Desktop
4. Install **"Toolchain Manager"** from the app list
5. Open Toolchain Manager and install the latest **nRF Connect SDK** (v2.7.0 or newer)
   - This automatically installs west, Zephyr, ARM GCC toolchain, etc.

### Step 2: Install VS Code Extensions
1. Open VS Code
2. Install the **"nRF Connect for VS Code Extension Pack"**
   - This includes: nRF Connect, nRF DeviceTree, nRF Terminal, etc.
3. Restart VS Code after installation

## Project Creation Steps

### Step 3: Create New nRF Connect Application
1. In VS Code, open Command Palette (`Cmd+Shift+P`)
2. Type: **"nRF Connect: Create a new application"**
3. Select this option
4. Choose **"Copy a sample"**
5. Select the sample: **"samples/bluetooth/peripheral_uart"**
   - This is the perfect base for our BLE GATT server
6. Choose location: `/Users/loayyari/Documents/Work/Mentra/Projects/esp32s3_ble_glasses_sim_bidirectional/`
7. Name your application: **"nrf5340_ble_glasses_sim"**
8. Click **"Create Application"**

### Step 4: Configure for nRF5340 DK
1. VS Code should open your new project automatically
2. In the nRF Connect panel (left sidebar), you should see your application
3. Click **"Add build configuration"**
4. Select board: **"nrf5340dk_nrf5340_cpuapp"**
5. Click **"Build Configuration"**

## File Modifications

### Step 5: Update prj.conf
Replace the contents of `prj.conf` with:
```ini
# Bluetooth Configuration
CONFIG_BT=y
CONFIG_BT_PERIPHERAL=y
CONFIG_BT_DEVICE_NAME="NexSim"
CONFIG_BT_DEVICE_APPEARANCE=833
CONFIG_BT_MAX_CONN=1
CONFIG_BT_MAX_PAIRED=1

# BLE GATT Configuration
CONFIG_BT_GATT_SERVICE_CHANGED=y
CONFIG_BT_GATT_DYNAMIC_DB=y

# Logging Configuration
CONFIG_LOG=y
CONFIG_BT_DEBUG_LOG=y
CONFIG_LOG_DEFAULT_LEVEL=3

# Console and UART
CONFIG_CONSOLE=y
CONFIG_UART_CONSOLE=y
CONFIG_SERIAL=y

# Memory Management
CONFIG_HEAP_MEM_POOL_SIZE=4096
CONFIG_MAIN_STACK_SIZE=4096
CONFIG_SYSTEM_WORKQUEUE_STACK_SIZE=2048

# Performance and Power
CONFIG_BT_CTLR_TX_PWR_PLUS_8=y
CONFIG_BT_L2CAP_TX_MTU=247
CONFIG_BT_BUF_ACL_RX_SIZE=251
CONFIG_BT_BUF_ACL_TX_SIZE=251
```

### Step 6: Replace main.c
Replace the entire contents of `src/main.c` with:
```c
/*
 * nRF5340 BLE Glasses Protobuf Simulator
 * 
 * Ported from ESP32-C3 Arduino code to nRF Connect SDK
 * 
 * This application creates a BLE peripheral that:
 * - Advertises with the same UUIDs as the ESP32-C3 version
 * - Receives protobuf messages and logs them
 * - Detects control headers (0x02, 0xA0, 0xB0)
 * - Sends echo responses back to the client
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/byteorder.h>

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

/* Custom service and characteristic UUIDs - same as ESP32-C3 */
#define CUSTOM_SERVICE_UUID \
	BT_UUID_128_ENCODE(0x00004860, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

#define CUSTOM_RX_CHAR_UUID \
	BT_UUID_128_ENCODE(0x000071FF, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

#define CUSTOM_TX_CHAR_UUID \
	BT_UUID_128_ENCODE(0x000070FF, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

/* UUID instances */
static struct bt_uuid_128 custom_service_uuid = BT_UUID_INIT_128(CUSTOM_SERVICE_UUID);
static struct bt_uuid_128 custom_rx_char_uuid = BT_UUID_INIT_128(CUSTOM_RX_CHAR_UUID);
static struct bt_uuid_128 custom_tx_char_uuid = BT_UUID_INIT_128(CUSTOM_TX_CHAR_UUID);

/* Connection reference */
static struct bt_conn *current_conn;

/* Advertising data - include custom service UUID */
static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, CUSTOM_SERVICE_UUID),
};

/* Device name for scan response */
static const struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

/* Forward declarations */
static ssize_t write_protobuf_data(struct bt_conn *conn,
				   const struct bt_gatt_attr *attr,
				   const void *buf, uint16_t len,
				   uint16_t offset, uint8_t flags);

static void ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value);

/* Custom GATT service definition */
BT_GATT_SERVICE_DEFINE(custom_service,
	BT_GATT_PRIMARY_SERVICE(&custom_service_uuid),
	
	/* RX Characteristic - Phone → Glasses (Write) */
	BT_GATT_CHARACTERISTIC(&custom_rx_char_uuid.uuid,
			       BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_WRITE,
			       NULL, write_protobuf_data, NULL),
	
	/* TX Characteristic - Glasses → Phone (Notify) */
	BT_GATT_CHARACTERISTIC(&custom_tx_char_uuid.uuid,
			       BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(ccc_cfg_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* Protobuf message handler - equivalent to ESP32-C3 SimpleWriteCallback */
static ssize_t write_protobuf_data(struct bt_conn *conn,
				   const struct bt_gatt_attr *attr,
				   const void *buf, uint16_t len,
				   uint16_t offset, uint8_t flags)
{
	const uint8_t *data = buf;
	
	if (len == 0) {
		LOG_INF("[BLE] Received empty data - ignoring");
		return len;
	}

	LOG_INF("");
	LOG_INF("=== BLE DATA RECEIVED ===");
	
	/* Print hex representation */
	printk("[nRF5340] Received BLE data (%d bytes): ", len);
	for (int i = 0; i < len; i++) {
		printk("0x%02X ", data[i]);
	}
	printk("\n");
	
	/* Check control headers - same logic as ESP32-C3 */
	uint8_t firstByte = data[0];
	if (firstByte == 0x02) {
		LOG_INF("[PROTOBUF] Control header detected: 0x02 (Protobuf message)");
	} else if (firstByte == 0xA0) {
		LOG_INF("[AUDIO] Control header detected: 0xA0 (Audio data)");
	} else if (firstByte == 0xB0) {
		LOG_INF("[IMAGE] Control header detected: 0xB0 (Image data)");
	} else {
		LOG_INF("[UNKNOWN] Unknown control header: 0x%02X", firstByte);
	}
	
	/* Print ASCII representation */
	printk("[ASCII] Raw string: \"");
	for (int i = 0; i < len; i++) {
		if (data[i] >= 32 && data[i] <= 126) {
			printk("%c", data[i]);
		} else {
			printk(".");
		}
	}
	printk("\"\n");
	
	/* Send echo response via notification */
	char response[64];
	int response_len = snprintf(response, sizeof(response), 
				    "Echo: Received %d bytes", len);
	
	/* Use the TX characteristic's value attribute (index 2 is the TX characteristic) */
	const struct bt_gatt_attr *tx_attr = &custom_service.attrs[2];
	
	int err = bt_gatt_notify(conn, tx_attr, response, response_len);
	if (err) {
		LOG_ERR("Failed to send notification (err %d)", err);
	} else {
		LOG_INF("[nRF5340] Sent echo response: %s", response);
	}
	
	LOG_INF("=== END BLE DATA ===");
	LOG_INF("");
	
	return len;
}

/* Client Characteristic Configuration changed callback */
static void ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	bool notifications_enabled = (value == BT_GATT_CCC_NOTIFY);
	LOG_INF("Notifications %s", notifications_enabled ? "enabled" : "disabled");
}

/* Connection callbacks - equivalent to ESP32-C3 ServerCallbacks */
static void connected(struct bt_conn *conn, uint8_t err)
{
	char addr[BT_ADDR_LE_STR_LEN];
	
	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	
	if (err) {
		LOG_ERR("Connection failed (err 0x%02x)", err);
		return;
	}
	
	LOG_INF("[nRF5340] *** CLIENT CONNECTED! ***");
	LOG_INF("[nRF5340] Connection established successfully");
	LOG_INF("Connected to: %s", addr);
	
	current_conn = bt_conn_ref(conn);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	char addr[BT_ADDR_LE_STR_LEN];
	
	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	
	LOG_INF("[nRF5340] *** CLIENT DISCONNECTED! ***");
	LOG_INF("[nRF5340] Reason: 0x%02x", reason);
	LOG_INF("Disconnected from: %s", addr);
	
	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}
	
	/* Restart advertising automatically */
	int err = bt_le_adv_start(BT_LE_ADV_CONN_NAME, ad, ARRAY_SIZE(ad), NULL, 0);
	if (err) {
		LOG_ERR("Advertising failed to restart (err %d)", err);
	} else {
		LOG_INF("[nRF5340] Restarted advertising");
	}
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
};

/* Heartbeat thread */
static void heartbeat_thread(void)
{
	uint32_t uptime_seconds = 0;
	
	while (1) {
		uptime_seconds = k_uptime_get_32() / 1000;
		
		if (current_conn) {
			LOG_INF("[HEARTBEAT] Uptime: %u seconds | BLE Status: CONNECTED", 
				uptime_seconds);
		} else {
			LOG_INF("[HEARTBEAT] Uptime: %u seconds | BLE Status: ADVERTISING", 
				uptime_seconds);
		}
		
		k_sleep(K_SECONDS(10));
	}
}

/* Define heartbeat thread */
K_THREAD_DEFINE(heartbeat_tid, 1024, heartbeat_thread, NULL, NULL, NULL, 7, 0, 0);

/* Bluetooth ready callback */
static void bt_ready(int err)
{
	if (err) {
		LOG_ERR("Bluetooth init failed (err %d)", err);
		return;
	}

	LOG_INF("Bluetooth initialized");

	/* Start advertising */
	err = bt_le_adv_start(BT_LE_ADV_CONN_NAME, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
	if (err) {
		LOG_ERR("Advertising failed to start (err %d)", err);
		return;
	}

	LOG_INF("=== nRF5340 BLE GLASSES SIMULATOR ===");
	LOG_INF("Device Name: %s", CONFIG_BT_DEVICE_NAME);
	LOG_INF("Service UUID: 00004860-0000-1000-8000-00805f9b34fb");
	LOG_INF("TX Char (Phone→Glasses): 000071FF-0000-1000-8000-00805f9b34fb");
	LOG_INF("RX Char (Glasses→Phone): 000070FF-0000-1000-8000-00805f9b34fb");
	LOG_INF("========================================");
	LOG_INF("Advertising started successfully");
	LOG_INF("Ready for BLE connections...");
	LOG_INF("=== Send data via BLE to see protobuf logs ===");
}

/* Main function */
int main(void)
{
	LOG_INF("=== nRF5340 BLE Glasses Protobuf Simulator ===");
	LOG_INF("Device started successfully!");
	LOG_INF("Waiting for Bluetooth initialization...");

	/* Initialize the Bluetooth Subsystem */
	int err = bt_enable(bt_ready);
	if (err) {
		LOG_ERR("Bluetooth init failed (err %d)", err);
		return 0;
	}

	LOG_INF("Bluetooth initialization started");
	
	/* Main thread can return, heartbeat thread will continue */
	return 0;
}
```

## Build and Test Steps

### Step 7: Build the Project
1. In VS Code, go to the nRF Connect panel
2. Find your project and build configuration
3. Click the **"Build"** button (🔨 icon)
4. Wait for build to complete successfully

### Step 8: Flash to nRF5340 DK
1. Connect your nRF5340 DK to USB
2. In nRF Connect panel, click **"Flash"** button (⚡ icon)
3. Wait for flashing to complete

### Step 9: Monitor Serial Output
1. In nRF Connect panel, click **"Open Terminal"**
2. You should see the device starting up and advertising
3. Look for messages like:
   ```
   [00:00:00.123,456] <inf> main: === nRF5340 BLE GLASSES SIMULATOR ===
   [00:00:00.234,567] <inf> main: Advertising started successfully
   [00:00:10.000,000] <inf> main: [HEARTBEAT] Uptime: 10 seconds | BLE Status: ADVERTISING
   ```

### Step 10: Test with Python Scripts
1. Open a new terminal in your project directory
2. Test BLE discovery:
   ```bash
   cd /Users/loayyari/Documents/Work/Mentra/Projects/esp32s3_ble_glasses_sim_bidirectional
   .venv/bin/python ble_scanner.py
   ```
3. Test service discovery:
   ```bash
   .venv/bin/python service_scanner.py
   ```
4. Test protobuf communication:
   ```bash
   .venv/bin/python direct_connect_test.py
   ```

## Expected Results

- **Device Name**: Should appear as "NexSim" in BLE scans
- **Service UUID**: `00004860-0000-1000-8000-00805f9b34fb` should be discoverable
- **Protobuf Detection**: Sending 0x02, 0xA0, 0xB0 headers should trigger appropriate log messages
- **Echo Responses**: Device should send back "Echo: Received X bytes" notifications

## Troubleshooting

### If Build Fails:
1. Check that nRF Connect SDK is properly installed
2. Verify board is set to `nrf5340dk_nrf5340_cpuapp`
3. Clean and rebuild project

### If Flash Fails:
1. Check USB connection to nRF5340 DK
2. Press RESET button on board
3. Try using nRF Connect Programmer app as alternative

### If BLE Not Discoverable:
1. Check serial output for advertising messages
2. Restart the device
3. Make sure no other BLE device is using same name

This manual approach using the nRF Connect VS Code extension should give you a much more reliable setup than command-line installation!
