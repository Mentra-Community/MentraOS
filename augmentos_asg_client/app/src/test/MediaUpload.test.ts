import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';

describe('MediaUploadTest', () => {
    const UPLOAD_URL = 'https://dev.augmentos.org/api/photos/upload';
    const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkOWM2NTNkYi1iOTI3LTQyNjItOGNkNC1jNTYxN2M2ZGVkNDciLCJlbWFpbCI6ImxvcmlhbWlzdGFkaTc1QGdtYWlsLmNvbSIsIm9yZ2FuaXphdGlvbnMiOlsiNjgzNGMzNDM4MDIxZWU2OGJkZTdhYmM3Il0sImRlZmF1bHRPcmciOiI2ODM0YzM0MzgwMjFlZTY4YmRlN2FiYzciLCJpYXQiOjE3NDkzMzYwMTF9.oErxaAiRMV3A7c4cIwual9qGrTHTGfIAzc_OVMUE52o';

    it('should upload photo successfully', async () => {
        // Use the screenshot image from the project root
        const imageFile = path.resolve(__dirname, 'test_image.jpg');
        expect(fs.existsSync(imageFile)).toBe(true);
        expect(fs.statSync(imageFile).size).toBeGreaterThan(0);

        // Create form data
        const formData = new FormData();
        formData.append('photo', fs.createReadStream(imageFile));
        formData.append('requestId', `test_${Date.now()}`);

        try {
            // Make the request
            const response = await axios.post(UPLOAD_URL, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${AUTH_TOKEN}`
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            // Assertions
            expect(response.status).toBe(200);
            expect(response.data).toHaveProperty('success', true);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Upload failed. Response:', error.response?.data);
                console.error('Status:', error.response?.status);
            }
            throw error;
        }
    });
}); 