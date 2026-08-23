package com.mentra.asg_client.io.network.utils;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.Inet4Address;
import java.net.InetAddress;
import org.junit.Test;

public class HotspotNetworkUtilsTest {
    @Test
    public void parsesIpv4StreamEndpoint() {
        Inet4Address address =
                HotspotNetworkUtils.parseIpv4Endpoint("http://192.168.43.207:8788/session/stream");

        assertThat(address).isNotNull();
        assertThat(address.getHostAddress()).isEqualTo("192.168.43.207");
    }

    @Test
    public void rejectsHostnameAndInvalidIpv4Endpoint() {
        assertThat(HotspotNetworkUtils.parseIpv4Endpoint("https://ingest.example.com/whip"))
                .isNull();
        assertThat(HotspotNetworkUtils.parseIpv4Endpoint("http://192.168.43.999/whip")).isNull();
    }

    @Test
    public void matchesAddressUsingLiveInterfacePrefix() throws Exception {
        Inet4Address local = ipv4("192.168.43.1");

        assertThat(HotspotNetworkUtils.isAddressInSubnet(ipv4("192.168.43.207"), local, (short) 24))
                .isTrue();
        assertThat(HotspotNetworkUtils.isAddressInSubnet(ipv4("192.168.44.207"), local, (short) 24))
                .isFalse();
    }

    @Test
    public void supportsNonDefaultHotspotSubnetAndPrefix() throws Exception {
        assertThat(
                        HotspotNetworkUtils.isAddressInSubnet(
                                ipv4("10.42.31.99"), ipv4("10.42.0.1"), (short) 16))
                .isTrue();
        assertThat(
                        HotspotNetworkUtils.isAddressInSubnet(
                                ipv4("10.43.0.2"), ipv4("10.42.0.1"), (short) 16))
                .isFalse();
    }

    @Test
    public void respectsNonOctetPrefixBoundaries() throws Exception {
        Inet4Address local = ipv4("192.168.43.129");

        assertThat(HotspotNetworkUtils.isAddressInSubnet(ipv4("192.168.43.254"), local, (short) 25))
                .isTrue();
        assertThat(HotspotNetworkUtils.isAddressInSubnet(ipv4("192.168.43.127"), local, (short) 25))
                .isFalse();
    }

    @Test
    public void rejectsInvalidPrefixLength() throws Exception {
        Inet4Address local = ipv4("192.168.43.1");

        assertThat(HotspotNetworkUtils.isAddressInSubnet(ipv4("192.168.43.2"), local, (short) -1))
                .isFalse();
        assertThat(HotspotNetworkUtils.isAddressInSubnet(ipv4("192.168.43.2"), local, (short) 33))
                .isFalse();
    }

    private static Inet4Address ipv4(String address) throws Exception {
        return (Inet4Address) InetAddress.getByName(address);
    }
}
