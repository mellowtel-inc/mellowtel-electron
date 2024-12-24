import { Logger } from "../logger/logger";


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
