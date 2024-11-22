import { Logger } from "../logger/logger";
import SpeedTest from "@cloudflare/speedtest";
import { getLocalStorage, setLocalStorage } from "../storage/storage-helpers";
import { SPEED_REFRESH_INTERVAL } from "../constants";

export async function MeasureConnectionSpeed(): Promise<number> {
  return new Promise(async (resolve) => {
    resolve(100);
    return ;
    let savedSpeedTestResults = await getSavedSpeedTestResults();
    let speedMbps = savedSpeedTestResults.speedMbps;
    let speedTestTimestamp = savedSpeedTestResults.speedTestTimestamp;

    if (speedMbps === undefined || didSpeedTestExpire(speedTestTimestamp)) {
      Logger.log("[MeasureConnectionSpeed]: Running speed test...");
      const speedTest = new SpeedTest({
        autoStart: false,
        measurements: [{ type: "download", bytes: 10e6, count: 1 }],
      });

      speedTest.onFinish = async (results) => {
        const bandwidth = results.getDownloadBandwidth();
        if (!bandwidth) {
          Logger.log("Speed test failed. Could not get bandwidth");
          resolve(0);
        } else {
          const speedMbps = (bandwidth / 1e6).toFixed(2);
          Logger.log(`Speed test finished. Download bandwidth: ${speedMbps} Mbps`);
          await saveSpeedTestResults(parseFloat(speedMbps));
          resolve(parseFloat(speedMbps));
        }
      };

      speedTest.play();
    } else {
      Logger.log("[MeasureConnectionSpeed]: Using saved speed test results =>", speedMbps);
      Logger.log("[MeasureConnectionSpeed]: Speed test timestamp =>", speedTestTimestamp);
      resolve(speedMbps);
    }
  });
}

async function saveSpeedTestResults(speedMbps: number): Promise<boolean> {
  return new Promise(async (resolve) => {
    let timestamp = new Date().getTime();
    await setLocalStorage("speedMbps", speedMbps);
    await setLocalStorage("speedTestTimestamp", timestamp);
    resolve(true);
  });
}

async function getSavedSpeedTestResults(): Promise<{ speedMbps: number; speedTestTimestamp: number }> {
  return new Promise(async (resolve) => {
    let speedMbps = await getLocalStorage("speedMbps");
    if (speedMbps === undefined || !speedMbps.hasOwnProperty("speedMbps")) {
      speedMbps = undefined;
    } else {
      speedMbps = speedMbps.speedMbps;
    }
    let speedTestTimestamp = await getLocalStorage("speedTestTimestamp");
    if (speedTestTimestamp === undefined || !speedTestTimestamp.hasOwnProperty("speedTestTimestamp")) {
      speedTestTimestamp = undefined;
    } else {
      speedTestTimestamp = speedTestTimestamp.speedTestTimestamp;
    }
    resolve({
      speedMbps: speedMbps,
      speedTestTimestamp: speedTestTimestamp,
    });
  });
}

function didSpeedTestExpire(timestamp: number | undefined): boolean {
  if (timestamp === undefined) {
    return true;
  }
  const now = new Date().getTime();
  return now - timestamp > SPEED_REFRESH_INTERVAL;
}