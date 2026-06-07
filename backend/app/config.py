"""
Environment detection for routing requests to appropriate backend service
"""
import os

# Detect if we're in training service environment
IS_TRAINING_SERVICE = os.environ.get('SERVICE_TYPE') == 'training'

# Training service URL (for forwarding from main backend)
TRAINING_SERVICE_URL = os.environ.get('TRAINING_SERVICE_URL', 'http://training:8000')

# Main backend URL
MAIN_BACKEND_URL = os.environ.get('MAIN_BACKEND_URL', 'http://backend:8000')
