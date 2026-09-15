import { Logger } from "../logger/logger";
import { ObservedError } from "../observability/observed-error";
import { DataRequest } from "./data-request";
import { getIdentifier } from "./identity-helpers";


// Mocking these functions as they are not available in the current context
const getFromRequestInfoStorage = async (recordID: string) => {
  Logger.log(`Mock getFromRequestInfoStorage for ${recordID}`);
  return { statusCode: 200 };
};

export async function getS3SignedUrls(recordID: string, contentType: string): Promise<{ uploadUrl: string, fileName: string }> {
  const response = await fetch(`https://request.mellow.tel/generate-upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ record_id: recordID, content_type: contentType }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    Logger.error(`[getS3SignedUrls]: Network response was not ok: ${errorText}`);
    throw new ObservedError(`[getS3SignedUrls]: Network response was not ok: ${errorText}`, {
      code: 'S3_SIGN_FAILED',
      stage: 's3',
      raw: { status: response.status, statusText: response.statusText, body: errorText },
    });
  }
  const data = await response.json();
  Logger.log("[getS3SignedUrls]: Response from server:", data);
  return {
    uploadUrl: data.uploadUrl,
    fileName: data.fileName
  };
}

export async function uploadToS3(
  uploadURL: string,
  contentType: string,
  fileBytes: any,
) {
  const byteArray = new Uint8Array(fileBytes);
  const response = await fetch(uploadURL, {
    method: "PUT",
    body: byteArray,
    headers: {
      "Content-Type": contentType,
      "x-amz-acl": "public-read",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    Logger.error(`[uploadToS3]: S3 upload failed with status ${response.status}. Response: ${errorText}`);
    throw new ObservedError(`[uploadToS3]: S3 upload failed. ${errorText}`, {
      code: 'S3_UPLOAD_FAILED',
      stage: 's3',
      raw: { status: response.status, statusText: response.statusText, body: errorText },
    });
  }

  Logger.log("[uploadToS3]: Response from server:", response.status, response.statusText);
  return response;
}


export async function saveCrawl(
  datarequest: DataRequest,
  content: string,
  markDown: string | undefined,
  BATCH_execution: boolean,
  batch_id: string,
  website_unreachable: boolean = false,
  cereal_result: any = {},
  file_name_bytes: string = "",
  cereal_success: boolean = true
) {
  Logger.log("📋 Saving Crawl 📋");
  Logger.log("RecordID:", datarequest.recordID);

  const node_identifier: string = getIdentifier()

  let endpoint: string = "https://request.mellow.tel/";
  if (datarequest.save_html_endpoint) {
    endpoint = datarequest.save_html_endpoint;
  }
  Logger.log("Node Identifier:", node_identifier);
  let moreInfo: any = await getFromRequestInfoStorage(datarequest.recordID);
  Logger.log("[saveCrawl] => More Info:", moreInfo);

  let bodyData: any = {
    recordID: datarequest.recordID,
    fastLane: datarequest.fastLane,
    url: datarequest.url,
    htmlTransformer: datarequest.htmlTransformer,
    orgId: datarequest.orgId,
    saveText: datarequest.saveText,
    node_identifier: node_identifier,
    BATCH_execution: BATCH_execution,
    batch_id: batch_id,
    final_url: datarequest.finalUrl || datarequest.url,
    website_unreachable: website_unreachable,
    statusCode: moreInfo.statusCode,
    requestMessageInfo: datarequest.json,
    saveHtml: datarequest.saveHtml,
    saveMarkdown: datarequest.saveMarkdown,
    cereal_result: JSON.stringify({ "data": cereal_result, "success": cereal_success }),
    file_name_bytes: file_name_bytes,
    actionResults: datarequest.actionResults || [],
    actionsFailed: (datarequest.actionResults || []).some((r) => r.status === "failed" || r.status === "timeout")
  };
  
  // For parser jobs, only send JSON and skip HTML/markdown
  if (datarequest.parser_job) {
    bodyData["json"] = JSON.stringify(cereal_result);
  } else {
    // For non-parser jobs, send HTML and markdown as usual
    if (datarequest.saveHtml) {
      bodyData["content"] = content;
    }
    if (datarequest.saveMarkdown) {
      bodyData["markDown"] = markDown;
    }
  }

  const requestOptions = {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(bodyData),
  };

  Logger.log("Sending data to server:", bodyData);

  try {
    const response = await fetch(endpoint, requestOptions);
    if (!response.ok) {
      const errorText = await response.text();
      Logger.error(`[saveCrawl] Network response was not ok: ${errorText}`);
      throw new ObservedError(`[saveCrawl] Network response was not ok: ${errorText}`, {
        code: 'SAVE_CRAWL_FAILED',
        stage: 'save_crawl',
        raw: { status: response.status, statusText: response.statusText, body: errorText, endpoint },
      });
    }
    const data = await response.json();
    Logger.log("Response from server:", data);
    return data;
  } catch (error) {
    Logger.error("Error in saveCrawl:", error);
    if (error instanceof ObservedError) {
      throw error;
    }
    throw new ObservedError(`Error in saveCrawl: ${error}`, {
      code: 'SAVE_CRAWL_FAILED',
      stage: 'save_crawl',
      raw: { endpoint, error: String(error) },
      cause: error,
    });
  }
}
