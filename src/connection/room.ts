// skipcq: JS-0108
import { getPublicIP } from "./ip";
import { baseURL, httpScheme, iceServers, wsScheme } from "../config";

class Room {
  handler: MasterHandler | ClientHandler;

  private constructor(
    public isMaster: boolean,
    public id: string,
    public name: string,
    public emoji: string,
    private ws: WebSocket,
    private clientKey: string,
    public pin?: string
  ) {
    this.handler = isMaster ? new MasterHandler(ws) : new ClientHandler(ws);

    ws.addEventListener("close", this.handleClose.bind(this));
  }

  static async create(): Promise<Room | undefined> {
    const response = await fetch(`${httpScheme}${baseURL}/room`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(await getDiscoveryParams()),
    });

    const [roomID, masterKey, clientKey, roomName, pin, emoji] =
      await response.json();

    const ws = await this.initWS(roomID, masterKey, true);

    if (ws === undefined) {
      return undefined;
    }
    return new Room(true, roomID, roomName, emoji, ws, clientKey, pin);
  }

  static async joinDirect(
    id: string,
    key: string,
    name: string,
    emoji: string
  ) {
    const ws = await this.initWS(id, key, false);
    if (ws === undefined) {
      return undefined;
    }

    return new Room(false, id, name, emoji, ws, key);
  }

  static async initWS(
    id: string,
    key: string,
    isMaster: boolean
  ): Promise<WebSocket | undefined> {
    const ws = new WebSocket(
      `${wsScheme}${baseURL}/ws/${id}?k=${key}&m=${isMaster ? "t" : "f"}`
    );

    const canConnect = await new Promise<boolean>((resolve) => {
      function close(_event: CloseEvent) {
        ws.removeEventListener("close", close);
        resolve(false);
      }

      ws.addEventListener("close", close);

      function message(event: MessageEvent) {
        try {
          if (JSON.parse(event.data)[0] === "-1") {
            resolve(true);
          } else {
            resolve(false);
          }
        } catch {
          resolve(false);
        } finally {
          ws.removeEventListener("message", message);
        }
      }

      ws.addEventListener("message", message);
    });

    if (canConnect) {
      return ws;
    }

    if (ws.readyState !== ws.CLOSED || ws.readyState !== ws.CLOSING) {
      ws.close();
    }

    return undefined;
  }

  constructHash() {
    return `k=${this.clientKey}&n=${this.name}&e=${this.emoji}`;
  }

  close() {
    this.ws.close();
  }

  private handleClose(_event: CloseEvent) {
    this.handler.goodbye();
  }
}

const metaChannelLabel = "meta";

class MasterHandler {
  clients: Map<String, MasterClient>;

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", this.handleMessage.bind(this));
    this.clients = new Map();
  }

  goodbye() {}

  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);

      switch (data[0]) {
        case "0":
          this.handleJoin(data);
          break;

        case "1":
          this.handleLeave(data);
          break;

        case "2":
          this.handleSignalMessage(data);
          break;
      }
    } catch {}
  }

  private handleJoin(data: string[]) {
    if (data.length < 2) {
      return;
    }
    this.clients.set(
      data[1],
      new MasterClient(
        data[1],
        (id, signal) => {
          this.ws.send(JSON.stringify(["0", id, signal]));
        },
        () => {
          // TODO(AG): Handle closure
        }
      )
    );
  }

  private handleLeave(data: string[]) {
    if (data.length < 2) {
      return;
    }

    const client = this.clients.get(data[1]);
    if (client) {
      client.remoteClose();
    }

    this.clients.delete(data[1]);
    // TODO(AG): Perform cleanup
  }

  private handleSignalMessage(data: string[]) {
    if (data.length < 3) {
      return;
    }

    const [_, id, message] = data;
    const client = this.clients.get(id);
    if (client) {
      client.handleSignal(message);
    }
  }
}

enum MasterClientSignal {
  OFFER,
  TRICKLE_ICE,
}

enum ClientMasterSignal {
  ANSWER,
  TRICKLE_ICE,
}

class MasterClient {
  closed: boolean;

  pc: RTCPeerConnection;
  metaChannel: RTCDataChannel;

  constructor(
    private id: string,
    private sendSignal: (id: string, signal: string) => void,
    private _onClose: () => void
  ) {
    this.closed = false;

    this.pc = new RTCPeerConnection({ ...iceServers });
    this.pc.addEventListener("icecandidate", this.onIceCandidate.bind(this));

    this.metaChannel = this.pc.createDataChannel(metaChannelLabel);
    this.metaChannel.addEventListener("open", this.metaChannelOpen.bind(this));
    this.metaChannel.addEventListener(
      "close",
      this.metaChannelClose.bind(this)
    );
    // noinspection JSIgnoredPromiseFromCall
    this.makeOffer();
  }

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (event.candidate) {
      this.sendSignal(
        this.id,
        JSON.stringify([MasterClientSignal.TRICKLE_ICE, event.candidate])
      );
    }
  }

  public handleSignal(signal: string) {
    try {
      const data = JSON.parse(signal);

      switch (data[0]) {
        case ClientMasterSignal.ANSWER:
          console.log("Answer:", data[1]);
          // noinspection JSIgnoredPromiseFromCall
          this.handleAnswer(data);
          break;

        case ClientMasterSignal.TRICKLE_ICE:
          console.log("Trickle ICE:", data[1]);
          // noinspection JSIgnoredPromiseFromCall
          this.handleTrickleIce(data);
          break;
      }
    } catch {}
  }

  private async handleAnswer(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.setRemoteDescription(data[1]);
  }

  private async handleTrickleIce(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.addIceCandidate(data[1]);
  }

  private async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal(
      this.id,
      JSON.stringify([MasterClientSignal.OFFER, this.pc.localDescription])
    );
  }

  private metaChannelOpen(_event: Event) {
    console.log("Open!");
  }

  private metaChannelClose(_event: Event) {
    console.log("Closed");
  }

  remoteClose() {
    this.closed = true;
    this.pc.close();
  }
}

class ClientHandler {
  private pc: RTCPeerConnection;
  private metaChannel: RTCDataChannel;

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", this.handleMessage.bind(this));

    this.pc = new RTCPeerConnection({ ...iceServers });
    this.pc.addEventListener("icecandidate", this.onIceCandidate.bind(this));
    this.pc.addEventListener(
      "connectionstatechange",
      this.onConnectionStateChange.bind(this)
    );
    this.pc.addEventListener("datachannel", this.onDataChannel.bind(this));
  }

  goodbye() {}

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (event.candidate) {
      this.sendSignal(
        JSON.stringify([ClientMasterSignal.TRICKLE_ICE, event.candidate])
      );
    }
  }

  private onConnectionStateChange(_event: Event) {
    console.log("Connection state:", this.pc.connectionState);
  }

  private async onDataChannel(event: RTCDataChannelEvent) {
    if (event.channel.label === metaChannelLabel) {
      this.metaChannel = event.channel;
      console.log("New data channel:", event.channel);
    }
  }

  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);

      switch (data[0]) {
        case "0":
          this.handleSignalMessage(data);
          break;

        case "1":
          this.handleGone(data);
          break;
      }
    } catch {}
  }

  private handleSignalMessage(data: string[]) {
    if (data.length < 2) {
      return;
    }

    const peerMessage = JSON.parse(data[1]);

    switch (peerMessage[0]) {
      case MasterClientSignal.OFFER:
        console.log("Remote offer", peerMessage[1]);
        // noinspection JSIgnoredPromiseFromCall
        this.handleOffer(peerMessage);
        break;

      case MasterClientSignal.TRICKLE_ICE:
        console.log("Remote trickle", peerMessage[1]);
        // noinspection JSIgnoredPromiseFromCall
        this.handleTrickleIce(peerMessage);
        break;
    }
  }

  private async handleTrickleIce(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.addIceCandidate(data[1]);
  }

  private async handleOffer(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.setRemoteDescription(data[1]);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal(
      JSON.stringify([ClientMasterSignal.ANSWER, this.pc.localDescription])
    );
  }

  private sendSignal(message: string) {
    this.ws.send(JSON.stringify(["0", message]));
  }

  private handleGone(_data: string[]) {}
}

async function getDiscoveryParams() {
  try {
    const ip = await getPublicIP();
    if (ip !== undefined) {
      return ["t", ip];
    }

    return ["f", ""];
  } catch {
    return ["f", ""];
  }
}

export default Room;
