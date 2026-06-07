import { test, expect, Page } from '@playwright/test';

test.describe('YOLO Auto-Annotation', () => {
  test('should call preannotate API when clicking Start Annotation button', async ({ page }) => {
    // Navigate to home and find a dataset
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Get first project URL from API to navigate directly
    const projectsResponse = await page.request.get('http://localhost:9999/projects/');
    const projects = await projectsResponse.json();
    
    if (projects.length > 0) {
      const firstProject = projects[0];
      
      // Get datasets for this project
      const datasetsResponse = await page.request.get(`http://localhost:9999/datasets/?project_id=${firstProject.id}`);
      const datasets = await datasetsResponse.json();
      
      if (datasets.length > 0) {
        const firstDataset = datasets[0];
        
        // Navigate directly to dataset detail page
        await page.goto(`/projects/${firstProject.id}/datasets/${firstDataset.id}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
        
        // Set up network listener BEFORE clicking button
        const requestPromise = page.waitForRequest(
          request => request.url().includes('/preannotate') && request.method() === 'POST',
          { timeout: 15000 }
        );
        
        const responsePromise = page.waitForResponse(
          response => response.url().includes('/preannotate'),
          { timeout: 15000 }
        );
        
        // Try to click Auto-Annotate button
        const autoAnnotateButton = page.locator('button:has-text("Auto-Annotate")');
        await expect(autoAnnotateButton).toBeVisible({ timeout: 10000 });
        await autoAnnotateButton.click();
        
        // Modal should appear
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
        
        // Select YOLO11 Medium
        const yoloButton = page.locator('button:has-text("YOLO11 Medium")').first();
        await expect(yoloButton).toBeVisible({ timeout: 3000 });
        await yoloButton.click();
        await page.waitForTimeout(500);

        // Pick detection task (default)
        const detectButton = page.locator('button:has-text("Detection")').first();
        await expect(detectButton).toBeVisible({ timeout: 3000 });
        await detectButton.click();
        
        // Start button should be enabled
        const startButton = page.locator('button:has-text("Start Annotation")');
        await expect(startButton).toBeEnabled({ timeout: 3000 });
        
        // Click Start Annotation and wait for API call (scroll into view first as it may be in a modal)
        await startButton.scrollIntoViewIfNeeded();
        await startButton.evaluate((btn: HTMLButtonElement) => btn.click());
        
        // Wait for the API request and response
        const request = await requestPromise;
        const response = await responsePromise;
        
        // Verify request was made
        expect(request.method()).toBe('POST');
        expect(request.url()).toContain('/preannotate');
        
        // Verify response
        expect(response.status()).toBe(200);
        const responseData = await response.json();
        expect(responseData.success).toBe(true);
        expect(responseData.task_id).toBeGreaterThan(0);
        
        console.log(`UI called API, response:`, responseData);
        
        // Verify toast appears (use first() to handle multiple matches)
        await expect(page.getByText(/Auto-annotation started/i).first()).toBeVisible({ timeout: 5000 });
        
        // Verify the task actually exists in the database
        const taskCheckResponse = await page.request.get(`http://localhost:9999/tasks/${responseData.task_id}`);
        expect(taskCheckResponse.ok()).toBeTruthy();
        const taskData = await taskCheckResponse.json();
        
        console.log(`Task ${responseData.task_id} details:`, taskData);
        
        expect(taskData.id).toBe(responseData.task_id);
        expect(taskData.task_type).toBe('preannotate');
        expect(taskData.name).toContain('Auto-annotate');
        
        console.log(`✓ UI successfully called API and created task ${responseData.task_id}`);
      } else {
        console.log('No datasets found, skipping UI test');
      }
    } else {
      console.log('No projects found, skipping UI test');
    }
  });

  test('should call preannotate API endpoint and create task', async ({ request }) => {
    // Test the API endpoint directly - most reliable way
    // First, get a dataset to use
    const datasetsResponse = await request.get('http://localhost:9999/datasets/');
    expect(datasetsResponse.ok()).toBeTruthy();
    
    const datasets = await datasetsResponse.json();
    
    if (datasets.length > 0) {
      const testDataset = datasets[0];
      
      // Call the preannotate endpoint
      const response = await request.post('http://localhost:9999/preannotate', {
        headers: {
          'Content-Type': 'application/json',
        },
        data: {
          model_name: 'yolo11m',
          dataset_id: testDataset.id,
          task_type: 'detect',
          annotation_file_name: `Test_Auto_${Date.now()}`
        }
      });
      
      expect(response.ok()).toBeTruthy();
      const responseData = await response.json();
      
      // Verify response structure
      expect(responseData).toHaveProperty('success', true);
      expect(responseData).toHaveProperty('task_id');
      expect(responseData.task_id).toBeGreaterThan(0);
      expect(responseData).toHaveProperty('message');
      expect(responseData.message).toContain('yolo11m');
      
      // Verify task was created
      const taskResponse = await request.get(`http://localhost:9999/tasks/${responseData.task_id}`);
      expect(taskResponse.ok()).toBeTruthy();
      
      const taskData = await taskResponse.json();
      expect(taskData.task_type).toBe('preannotate');
      expect(taskData.project_id).toBe(testDataset.project_id);
      expect(taskData.task_metadata).toHaveProperty('model_name', 'yolo11m');
      expect(taskData.task_metadata).toHaveProperty('dataset_id', testDataset.id);
      expect(taskData.status).toMatch(/pending|running|completed/);
    } else {
      console.log('No datasets found, skipping test');
    }
  });

  test('should verify task appears in active tasks list', async ({ request }) => {
    // Get datasets
    const datasetsResponse = await request.get('http://localhost:9999/datasets/');
    expect(datasetsResponse.ok()).toBeTruthy();
    const datasets = await datasetsResponse.json();
    
    if (datasets.length > 0) {
      const testDataset = datasets[0];
      
      // Create a preannotate task
      const createResponse = await request.post('http://localhost:9999/preannotate', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          model_name: 'yolo11m',
          dataset_id: testDataset.id,
          task_type: 'segment',
          annotation_file_name: `Test_Active_${Date.now()}`
        }
      });
      
      expect(createResponse.ok()).toBeTruthy();
      const createData = await createResponse.json();
      const taskId = createData.task_id;
      
      // Wait a moment for task to be fully created
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // First verify task exists
      const taskResponse = await request.get(`http://localhost:9999/tasks/${taskId}`);
      expect(taskResponse.ok()).toBeTruthy();
      const taskData = await taskResponse.json();
      
      // Task should exist
      expect(taskData.id).toBe(taskId);
      expect(taskData.task_type).toBe('preannotate');
      expect(taskData.project_id).toBe(testDataset.project_id);
      
      // If task is still pending or running, it should be in active tasks
      if (taskData.status === 'pending' || taskData.status === 'running') {
        const activeTasksResponse = await request.get(
          `http://localhost:9999/tasks/active?project_id=${testDataset.project_id}`
        );
        expect(activeTasksResponse.ok()).toBeTruthy();
        
        const activeTasks = await activeTasksResponse.json();
        const foundTask = activeTasks.find((task: any) => task.id === taskId);
        
        expect(foundTask).toBeDefined();
        expect(foundTask.name).toContain('yolo11m');
      } else {
        // Task completed/failed too quickly, just verify it exists
        console.log(`Task ${taskId} is already ${taskData.status}, not in active list`);
        expect(taskData.name).toContain('yolo11m');
      }
    } else {
      console.log('No datasets found, skipping test');
    }
  });
});


