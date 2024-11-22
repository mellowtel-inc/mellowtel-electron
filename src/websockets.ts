import WebSocket from 'isomorphic-ws';
import { MeasureConnectionSpeed } from './utils/measure-connection-speed';
import { RateLimiter } from './local-rate-limiting/rate-limiter';
import { Logger } from './logger/logger';
import { setLocalStorage } from './storage/storage-helpers';
import { getIdentifier } from './utils/identity-helpers';
import { VERSION, REFRESH_INTERVAL } from './constants';
import { getS3SignedUrls, scrapeUrl } from './utils/scraping-helpers'; // Import the scrapeUrl method
import { putHTMLToSigned, putMarkdownToSigned, updateDynamo } from './utils/put-to-signed';

const ws_url: string = "wss://7joy2r59rf.execute-api.us-east-1.amazonaws.com/production/";

export async function startConnectionWs(identifier: string): Promise<WebSocket> {
    Logger.log("############################################################");
    Logger.log(`[startConnectionWs]: Starting WebSocket connection`);

    let LIMIT_REACHED: boolean = await RateLimiter.getIfRateLimitReached();
    if (LIMIT_REACHED) {
        Logger.log(`[]: Rate limit, not connecting to websocket`);
        let { timestamp, count } = await RateLimiter.getRateLimitData();
        let now: number = Date.now();
        let timeElapsed = RateLimiter.calculateElapsedTime(now, timestamp);
        Logger.log(`[]: Time elapsed since last request: ${timeElapsed}`);
        if (timeElapsed > REFRESH_INTERVAL) {
            Logger.log(`[]: Time elapsed is greater than REFRESH_INTERVAL, resetting rate limit data`);
            await setLocalStorage("mllwtl_rate_limit_reached", false);
            await RateLimiter.resetRateLimitData(now, false);
            startConnectionWs(identifier);
        }
    } else {
        const extension_identifier: string = await getIdentifier();
        const speedMpbs: number = await MeasureConnectionSpeed();
        Logger.log(`[]: Connection speed: ${speedMpbs} Mbps`);
        const ws = new WebSocket(
            `${ws_url}?device_id=${identifier}&version=${VERSION}&plugin_id=${encodeURIComponent(extension_identifier)}&speed_download=${speedMpbs}`,
        );
        ws.onmessage = async function incoming(data: any) {
            try {
                const message = JSON.parse(data.data);
                if (message.url) {
                    Logger.log(`[WebSocket]: Received URL to scrape - ${message.url}`);
                    const scrapedContent = await scrapeUrl(message.url);
                    const { uploadURL_html, uploadURL_markDown } = await getS3SignedUrls(message.recordID);

                    // Upload HTML

                    await putHTMLToSigned(uploadURL_html, scrapedContent.html)
                    await putMarkdownToSigned(uploadURL_markDown, scrapedContent.markdown);
    
                    Logger.log(`[WebSocket]: Scraped html - ${scrapedContent.html}`);
                    Logger.log(`[WebSocket]: Scraped markdown - ${scrapedContent.markdown}`);
                    // Handle the scraped content (e.g., save it, send it back, etc.)

                    await updateDynamo(
                        message.recordID,
                        message.url,
                        message.htmlTransformer,
                        message.orgId,
                        "text_" + message.recordID + ".txt",
                        "markDown_" + message.recordID + ".txt",
                        "image_" + message.recordID + ".png",
                    )
                }
            } catch (error) {
                Logger.error(`[WebSocket]: Error handling message - ${error}`);
            }
        };
        return ws;
    }
}