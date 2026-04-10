/**
 * WHEP (WebRTC-HTTP Egress Protocol) client for low-latency video playback.
 * Based on Cloudflare's example implementation.
 * https://www.ietf.org/id/draft-murillo-whep-00.html
 */

async function negotiateConnectionWithClientOffer(
  peerConnection: RTCPeerConnection,
  endpoint: string,
  maxRetries: number = 10,
): Promise<string | null> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Wait for ICE gathering to complete (max 1 second)
  const localDescription = await new Promise<RTCSessionDescription | null>(
    (resolve) => {
      setTimeout(() => resolve(peerConnection.localDescription), 1000);
      peerConnection.onicegatheringstatechange = () => {
        if (peerConnection.iceGatheringState === "complete") {
          resolve(peerConnection.localDescription);
        }
      };
    },
  );

  if (!localDescription) {
    throw new Error("Failed to gather ICE candidates for offer");
  }

  let attempt = 0;

  while (peerConnection.connectionState !== "closed" && attempt < maxRetries) {
    attempt++;

    const response = await fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/sdp" },
      body: localDescription.sdp,
    });

    if (response.status === 201) {
      const answerSDP = await response.text();
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: answerSDP }),
      );
      return response.headers.get("Location");
    } else if (response.status === 405) {
      console.error("[WHEPClient] Invalid WHEP URL");
      return null;
    } else if (response.status === 409) {
      // 409 = "Live broadcast not started yet" — stream exists on Cloudflare
      // but nobody is sending media to it (stale/orphaned stream).
      const errorMessage = await response.text();
      console.warn(
        `[WHEPClient] Stream not live yet (attempt ${attempt}/${maxRetries}):`,
        errorMessage,
      );
      if (attempt >= maxRetries) {
        console.error("[WHEPClient] Giving up — stream appears stale");
        return null;
      }
    } else {
      const errorMessage = await response.text();
      console.error(
        `[WHEPClient] SDP negotiation error (${response.status}):`,
        errorMessage,
      );
    }

    // Retry with increasing backoff: 2s, 3s, 4s, 5s, 5s, ...
    await new Promise((r) =>
      setTimeout(r, Math.min(2000 + attempt * 1000, 5000)),
    );
  }

  return null;
}

export default class WHEPClient {
  private peerConnection: RTCPeerConnection;
  private stream: MediaStream;

  constructor(endpoint: string, videoElement: HTMLVideoElement) {
    this.stream = new MediaStream();

    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    });

    this.peerConnection.addTransceiver("video", { direction: "recvonly" });
    this.peerConnection.addTransceiver("audio", { direction: "recvonly" });

    this.peerConnection.ontrack = (event) => {
      const track = event.track;
      const currentTracks = this.stream.getTracks();
      const hasVideo = currentTracks.some((t) => t.kind === "video");
      const hasAudio = currentTracks.some((t) => t.kind === "audio");

      if (track.kind === "video" && !hasVideo) {
        this.stream.addTrack(track);
      } else if (track.kind === "audio" && !hasAudio) {
        this.stream.addTrack(track);
      }
    };

    this.peerConnection.addEventListener("connectionstatechange", () => {
      if (this.peerConnection.connectionState === "connected") {
        if (!videoElement.srcObject) {
          videoElement.srcObject = this.stream;
        }
      }
    });

    this.peerConnection.addEventListener("negotiationneeded", () => {
      negotiateConnectionWithClientOffer(this.peerConnection, endpoint);
    });
  }

  destroy(): void {
    this.peerConnection.close();
    this.stream.getTracks().forEach((track) => track.stop());
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.peerConnection.connectionState;
  }
}
