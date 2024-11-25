import { Logger } from "../logger/logger";

// https://github.com/TypeStrong/ts-node/discussions/1290
const dynamicImport = new Function('specifier', 'return import(specifier)');

export async function MeasureConnectionSpeed(): Promise<number> {
  return new Promise(async (resolve) => {

    Logger.log("[MeasureConnectionSpeed]: Running speed test...");

    const cloudSpeed = await dynamicImport('@cloudflare/speedtest')
    const speedTest = new cloudSpeed.default({
      autoStart: false,
      measurements: [{ type: "download", bytes: 10e6, count: 1 }],
    });

    speedTest.onFinish = async (results: any) => {
      const bandwidth = results.getDownloadBandwidth();
      if (!bandwidth) {
        Logger.log("Speed test failed. Could not get bandwidth");
        resolve(-1);
      } else {
        const speedMbps = (bandwidth / 1e6).toFixed(2);
        Logger.log(`Speed test finished. Download bandwidth: ${speedMbps} Mbps`);
        resolve(parseFloat(speedMbps));
      }
    };

    speedTest.play();


  });
}