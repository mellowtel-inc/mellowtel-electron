import { processUrl } from './src/utils/data-helpers';
import { DataRequest } from './src/utils/data-request';
import { Logger } from './src/logger/logger';
import { app } from 'electron';

// Enable logging for testing
Logger.disableLogs = false;

// Wait for Electron app to be ready
app.whenReady().then(async () => {
    try {
        // Create mock DataRequest with sample data
        const mockDataRequest = new DataRequest({
            url: `data:text/html,<iframe srcdoc='<script>alert("Cannot contact reCAPTCHA. Check your connection and try again.")</script>'></iframe>`, // Iframe srcdoc alert test
            orgId: 'test-org', // Organization ID (can be any string for testing)
            recordID: 'test-record-123', // Record ID (can be any string for testing)
            waitBeforeScraping: 0, // Wait time in seconds before scraping
            htmlVisualizer: false, // Set to true if you want screenshots
            fullpageScreenshot: false, // Set to true for full page screenshots
            removeCSSselectors: 'default', // CSS selectors to remove
            actions: [], // Array of actions to perform on the page
            windowSize: { width: 1709, height: 984 }, // Browser window size
            cerealObject: '{"useCereal": false}', // Disable cereal processing for testing
            saveMarkdown: true, // Save markdown output
            saveHtml: true // Save HTML output
        });

        Logger.log('Starting processUrl with mock data...');
        Logger.log('URL:', mockDataRequest.url);

        // Call processUrl function
        const result = await processUrl(mockDataRequest);

        Logger.log('=== RESULT ===');
        Logger.log('HTML length:', result.html.length);
        Logger.log('Markdown length:', result.markdown.length);
        Logger.log('Screenshot:', result.screenshot ? 'Captured' : 'Not captured');
        Logger.log('Content Type:', result.contentType);
        
        // Optionally log first 500 characters of HTML
        Logger.log('\nFirst 500 chars of HTML:');
        Logger.log(result.html.substring(0, 500));
        
        Logger.log('\nFirst 500 chars of Markdown:');
        Logger.log(result.markdown.substring(0, 500));

        Logger.log('\n✅ Test completed successfully!');
        
        // Exit the app
        app.quit();
    } catch (error) {
        Logger.error('Error during test:', error);
        app.quit();
    }
});

// Handle app activation (macOS)
app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
});
