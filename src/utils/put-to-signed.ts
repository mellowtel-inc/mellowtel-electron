import { Logger } from "../logger/logger";
import { DataRequest } from "./data-request";
import { getIdentifier } from "./identity-helpers";


// Mocking these functions as they are not available in the current context
const getFromRequestInfoStorage = async (recordID: string) => {
  Logger.log(`Mock getFromRequestInfoStorage for ${recordID}`);
  return { statusCode: 200 };
};

export async function getS3SignedUrls(recordID: string): Promise<{ uploadURL_html: string; uploadURL_markDown: string; uploadURL_htmlVisualizer: string }> {
  const response = await fetch(`https://5xub3rkd3rqg6ebumgrvkjrm6u0jgqnw.lambda-url.us-east-1.on.aws/?recordID=${recordID}`);
  if (!response.ok) {
    throw new Error("[getS3SignedUrls]: Network response was not ok");
  }
  const data = await response.json();
  Logger.log("[getS3SignedUrls]: Response from server:", data);
  return {
    uploadURL_html: data.uploadURL_html,
    uploadURL_markDown: data.uploadURL_markDown,
    uploadURL_htmlVisualizer: data.uploadURL_htmlVisualizer
  };
}

export function putHTMLToSigned(htmlURL_signed: string, content: string) {
  return new Promise((resolve) => {
    fetch(htmlURL_signed, {
      method: "PUT",
      body: content,
      headers: {
        "Content-Type": "text/html",
        "x-amz-acl": "public-read",
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("[putHTMLToSigned]: Network response was not ok");
        }
        return response;
      })
      .then((data) => {
        Logger.log("[putHTMLToSigned]: Response from server:", data);
        resolve(data);
      });
  });
}

export function putMarkdownToSigned(
  markdownURL_signed: string,
  markDown: string,
) {
  return new Promise((resolve) => {
    fetch(markdownURL_signed, {
      method: "PUT",
      body: markDown,
      headers: {
        "Content-Type": "text/markdown",
        "x-amz-acl": "public-read",
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("[putMarkdownToSigned]: Network response was not ok");
        }
        return response;
      })
      .then((data) => {
        Logger.log("[putMarkdownToSigned]: Response from server:", data);
        resolve(data);
      });
  });
}

export function putHTMLVisualizerToSigned(
  htmlVisualizerURL_signed: string,
  base64image: Buffer,
) {
  return new Promise((resolve) => {
    // const byteCharacters = atob(base64image.split(",")[1]);
    // const byteNumbers = new Array(byteCharacters.length);
    // for (let i = 0; i < byteCharacters.length; i++) {
    //   byteNumbers[i] = byteCharacters.charCodeAt(i);
    // }
    const byteArray = new Uint8Array(base64image);
    fetch(htmlVisualizerURL_signed, {
      method: "PUT",
      body: byteArray,
      headers: {
        "Content-Type": "image/png",
        "Content-Encoding": "base64",
        "x-amz-acl": "public-read",
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            "[putHTMLVisualizerToSigned]: Network response was not ok",
          );
        }
        return response;
      })
      .then((data) => {
        Logger.log("[putHTMLVisualizerToSigned]: Response from server:", data);
        resolve(data);
      });
  });
}

export function putHTMLContainedToSigned(
  htmlContainedURL_signed: string,
  htmlContainedString: string,
) {
  return new Promise((resolve) => {
    fetch(htmlContainedURL_signed, {
      method: "PUT",
      body: htmlContainedString,
      headers: {
        "Content-Type": "text/html",
        "x-amz-acl": "public-read",
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            "[putHTMLContainedToSigned]: Network response was not ok",
          );
        }
        return response;
      })
      .then((data) => {
        Logger.log("[putHTMLContainedToSigned]: Response from server:", data);
        resolve(data);
      });
  });
}


export async function saveCrawl(
  datarequest: DataRequest,
  content: string,
  markDown: string,
  BATCH_execution: boolean,
  batch_id: string,
  website_unreachable: boolean = false,
  cereal_result: any = {}
) {
  Logger.log("📋 Saving Crawl 📋");
  Logger.log("RecordID:", datarequest.recordID);

  const node_identifier: string = getIdentifier()

  let endpoint: string =
    "https://afcha2nmzsir4rr4zbta4tyy6e0fxjix.lambda-url.us-east-1.on.aws/";
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
    final_url: datarequest.url, //TODO: UPDATE TO ACTUAL FINAL URL
    website_unreachable: website_unreachable,
    statusCode: moreInfo.statusCode,
    requestMessageInfo: datarequest.json,
    saveHtml: datarequest.saveHtml,
    saveMarkdown: datarequest.saveMarkdown,
    cereal_result: JSON.stringify({"data": cereal_result, "success": true}),
  };
  if (datarequest.saveHtml) {
    bodyData["content"] = content;
  }
  if (datarequest.saveMarkdown) {
    bodyData["markDown"] = markDown;
  }

  const requestOptions = {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(bodyData),
  };

  Logger.log("Sending data to server:", bodyData);

  fetch(endpoint, requestOptions)
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json();
    })
    .then(async (data) => {
      Logger.log("Response from server:", data);
      return data;
    })
    .catch(async (error) => {
      Logger.error("Error:", error);
      return error;
    });
}

export async function updateDynamo(
  recordID: string,
  url: string,
  htmlTransformer: string,
  orgId: string,
  htmlKey: string = "--",
  markdownKey: string = "--",
  htmlVisualizerKey: string = "--",
): Promise<void> {
  Logger.log("📋  updateDynamo - Saving Data 📋");
  Logger.log("RecordID:", recordID);
  Logger.log("URL:", url);
  Logger.log("HTML Transformer:", htmlTransformer);
  Logger.log("OrgID:", orgId);
  Logger.log("HTML Key:", htmlKey);
  Logger.log("Markdown Key:", markdownKey);

  try {

    let endpoint: string = "https://zuaq4uywadlj75qqkfns3bmoom0xpaiz.lambda-url.us-east-1.on.aws/";

    const bodyData = {
      recordID,
      url,
      htmlTransformer,
      orgId,
      htmlFileName: htmlKey,
      markdownFileName: markdownKey,
      htmlVisualizerFileName: htmlVisualizerKey,
    };

    const requestOptions = {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(bodyData),
    };

    Logger.log("[updateDynamo]: Sending data to server =>", bodyData);

    const response = await fetch(endpoint, requestOptions);
    if (!response.ok) {
      throw new Error("Network response was not ok");
    }

    const data = await response.json();
    Logger.log("Response from server:", data);
  } catch (error) {
    Logger.error("Error:", error);
  }
}
