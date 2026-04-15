package com.mentra.asg_client.io.uvc.core;

import org.junit.Assert;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileWriter;

public class UvcDeviceLocatorTest {

  @Rule
  public TemporaryFolder tmp = new TemporaryFolder();

  @Test
  public void returnsNullWhenNoDevicesExist() {
    File emptySys = new File(tmp.getRoot(), "sys_video");
    File emptyDev = new File(tmp.getRoot(), "dev");
    emptySys.mkdirs();
    emptyDev.mkdirs();

    UvcDeviceLocator locator = new UvcDeviceLocator(emptySys.getAbsolutePath(), emptyDev.getAbsolutePath());
    Assert.assertNull("Should return null when no devices exist",
        locator.findGadgetOutputDevicePath());
  }

  @Test
  public void prefersNodeNamedUvc() throws Exception {
    File sysBase = new File(tmp.getRoot(), "sys_video");
    File devBase = new File(tmp.getRoot(), "dev");
    sysBase.mkdirs();
    devBase.mkdirs();

    createSysEntry(sysBase, "video0", "camera_capture");
    createSysEntry(sysBase, "video1", "uvc_gadget");
    createDevNode(devBase, "video0");
    createDevNode(devBase, "video1");

    UvcDeviceLocator locator = new UvcDeviceLocator(sysBase.getAbsolutePath(), devBase.getAbsolutePath());
    String result = locator.findGadgetOutputDevicePath();

    Assert.assertNotNull("Should find a device", result);
    Assert.assertTrue("Should prefer the uvc_gadget-named node (video1)",
        result.contains("video1"));
  }

  @Test
  public void fallsBackToFirstNodeWhenNoUvcName() throws Exception {
    File sysBase = new File(tmp.getRoot(), "sys_video");
    File devBase = new File(tmp.getRoot(), "dev");
    sysBase.mkdirs();
    devBase.mkdirs();

    createSysEntry(sysBase, "video0", "some_generic_device");
    createSysEntry(sysBase, "video1", "another_device");
    createDevNode(devBase, "video0");
    createDevNode(devBase, "video1");

    UvcDeviceLocator locator = new UvcDeviceLocator(sysBase.getAbsolutePath(), devBase.getAbsolutePath());
    String result = locator.findGadgetOutputDevicePath();

    Assert.assertNotNull("Should fall back to first available node", result);
    Assert.assertTrue("Fallback should be a valid path",
        result.contains("video0") || result.contains("video1"));
  }

  @Test
  public void skipsNonExistentDevFiles() throws Exception {
    File sysBase = new File(tmp.getRoot(), "sys_video");
    File devBase = new File(tmp.getRoot(), "dev");
    sysBase.mkdirs();
    devBase.mkdirs();

    createSysEntry(sysBase, "video0", "some_device");
    // no corresponding /dev/video0 file

    createSysEntry(sysBase, "video1", "uvc_gadget");
    createDevNode(devBase, "video1");

    UvcDeviceLocator locator = new UvcDeviceLocator(sysBase.getAbsolutePath(), devBase.getAbsolutePath());
    String result = locator.findGadgetOutputDevicePath();

    Assert.assertNotNull("Should find video1 despite video0 being absent from /dev", result);
    Assert.assertTrue("Should return video1 (present in /dev)", result.contains("video1"));
  }

  @Test
  public void skipsCameraNamedNodes() throws Exception {
    File sysBase = new File(tmp.getRoot(), "sys_video");
    File devBase = new File(tmp.getRoot(), "dev");
    sysBase.mkdirs();
    devBase.mkdirs();

    createSysEntry(sysBase, "video0", "camera_capture_main");
    createSysEntry(sysBase, "video1", "isp_output");
    createSysEntry(sysBase, "video2", "uvc_output");
    createDevNode(devBase, "video0");
    createDevNode(devBase, "video1");
    createDevNode(devBase, "video2");

    UvcDeviceLocator locator = new UvcDeviceLocator(sysBase.getAbsolutePath(), devBase.getAbsolutePath());
    String result = locator.findGadgetOutputDevicePath();

    Assert.assertNotNull("Should find video2", result);
    Assert.assertTrue("Should skip camera/isp nodes and choose video2",
        result.contains("video2"));
  }

  @Test
  public void findOutputDevicePathDelegatesToGadgetMethod() throws Exception {
    File sysBase = new File(tmp.getRoot(), "sys_video");
    File devBase = new File(tmp.getRoot(), "dev");
    sysBase.mkdirs();
    devBase.mkdirs();

    createSysEntry(sysBase, "video0", "uvc_gadget");
    createDevNode(devBase, "video0");

    UvcDeviceLocator locator = new UvcDeviceLocator(sysBase.getAbsolutePath(), devBase.getAbsolutePath());
    Assert.assertEquals(
        "findOutputDevicePath() should delegate to findGadgetOutputDevicePath()",
        locator.findGadgetOutputDevicePath(),
        locator.findOutputDevicePath());
  }

  private void createSysEntry(File sysBase, String nodeName, String name) throws Exception {
    File nodeDir = new File(sysBase, nodeName);
    nodeDir.mkdirs();
    try (FileWriter fw = new FileWriter(new File(nodeDir, "name"))) {
      fw.write(name);
    }
  }

  private void createDevNode(File devBase, String name) throws Exception {
    new File(devBase, name).createNewFile();
  }
}
