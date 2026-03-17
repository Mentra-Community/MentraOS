declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number)
    encodeBuffer(left: Int16Array, right?: Int16Array): Int32Array
    flush(): Int32Array
  }
  export default { Mp3Encoder }
}
