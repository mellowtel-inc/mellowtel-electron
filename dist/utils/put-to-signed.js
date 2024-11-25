"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.putHTMLToSigned = putHTMLToSigned;
exports.putMarkdownToSigned = putMarkdownToSigned;
exports.putHTMLVisualizerToSigned = putHTMLVisualizerToSigned;
exports.putHTMLContainedToSigned = putHTMLContainedToSigned;
exports.updateDynamo = updateDynamo;
const logger_1 = require("../logger/logger");
function putHTMLToSigned(htmlURL_signed, content) {
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
            logger_1.Logger.log("[putHTMLToSigned]: Response from server:", data);
            resolve(data);
        });
    });
}
function putMarkdownToSigned(markdownURL_signed, markDown) {
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
            logger_1.Logger.log("[putMarkdownToSigned]: Response from server:", data);
            resolve(data);
        });
    });
}
function putHTMLVisualizerToSigned(htmlVisualizerURL_signed, base64image) {
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
                throw new Error("[putHTMLVisualizerToSigned]: Network response was not ok");
            }
            return response;
        })
            .then((data) => {
            logger_1.Logger.log("[putHTMLVisualizerToSigned]: Response from server:", data);
            resolve(data);
        });
    });
}
function putHTMLContainedToSigned(htmlContainedURL_signed, htmlContainedString) {
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
                throw new Error("[putHTMLContainedToSigned]: Network response was not ok");
            }
            return response;
        })
            .then((data) => {
            logger_1.Logger.log("[putHTMLContainedToSigned]: Response from server:", data);
            resolve(data);
        });
    });
}
async function updateDynamo(recordID, url, htmlTransformer, orgId, htmlKey = "--", markdownKey = "--", htmlVisualizerKey = "--") {
    logger_1.Logger.log("📋  updateDynamo - Saving Crawl 📋");
    logger_1.Logger.log("RecordID:", recordID);
    logger_1.Logger.log("URL:", url);
    logger_1.Logger.log("HTML Transformer:", htmlTransformer);
    logger_1.Logger.log("OrgID:", orgId);
    logger_1.Logger.log("HTML Key:", htmlKey);
    logger_1.Logger.log("Markdown Key:", markdownKey);
    try {
        let endpoint = "https://zuaq4uywadlj75qqkfns3bmoom0xpaiz.lambda-url.us-east-1.on.aws/";
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
        logger_1.Logger.log("[updateDynamo]: Sending data to server =>", bodyData);
        const response = await fetch(endpoint, requestOptions);
        if (!response.ok) {
            throw new Error("Network response was not ok");
        }
        const data = await response.json();
        logger_1.Logger.log("Response from server:", data);
    }
    catch (error) {
        logger_1.Logger.error("Error:", error);
    }
}
