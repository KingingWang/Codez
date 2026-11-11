export interface HelloMessage {
  type: "codez-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "codez-hello-ack";
  version: string;
  clientId: string;
}
