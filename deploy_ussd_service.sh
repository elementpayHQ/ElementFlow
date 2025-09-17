#!/bin/bash

# ElementPay USSD Service Deployment Script
# This script fixes the redirect loop issue and deploys the service

set -e

echo "🚀 ElementPay USSD Service Deployment"
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   print_error "This script must be run as root"
   exit 1
fi

print_status "Checking system requirements..."

# Check Python version
if ! command -v python3 &> /dev/null; then
    print_error "Python3 is not installed"
    exit 1
fi

PYTHON_VERSION=$(python3 --version | cut -d' ' -f2)
print_success "Python3 version: $PYTHON_VERSION"

# Install required packages
print_status "Installing required Python packages..."

pip3 install fastapi uvicorn python-multipart

print_success "Python packages installed"

# Stop existing service if running
print_status "Stopping existing USSD service..."
systemctl stop elementpay_ussd.service 2>/dev/null || true

# Copy service file
print_status "Installing systemd service..."
cp elementpay_ussd.service /etc/systemd/system/
systemctl daemon-reload

# Make service file executable
chmod 644 /etc/systemd/system/elementpay_ussd.service

# Copy the fixed USSD service
print_status "Deploying fixed USSD service..."
cp ussd_service_fix.py /root/
chmod +x /root/ussd_service_fix.py

# Enable and start service
print_status "Starting USSD service..."
systemctl enable elementpay_ussd.service
systemctl start elementpay_ussd.service

# Wait a moment for service to start
sleep 3

# Check service status
if systemctl is-active --quiet elementpay_ussd.service; then
    print_success "USSD service is running"
else
    print_error "USSD service failed to start"
    systemctl status elementpay_ussd.service
    exit 1
fi

# Test the endpoint
print_status "Testing USSD endpoint..."

# Test POST request
echo "Testing POST /ussd/"
curl -X POST http://localhost:8002/ussd/ \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sessionId=test123&serviceCode=*123#&phoneNumber=1234567890&text=" \
  -s -w "\nHTTP Status: %{http_code}\n" || true

echo ""

# Test GET request
echo "Testing GET /ussd/"
curl -X GET "http://localhost:8002/ussd/?sessionId=test456&serviceCode=*123#&phoneNumber=1234567890&text=" \
  -s -w "\nHTTP Status: %{http_code}\n" || true

echo ""

# Test health endpoint
echo "Testing health endpoint..."
curl -X GET http://localhost:8002/health -s || true

echo ""

print_success "Deployment completed successfully!"
print_status "Service is running on port 8002"
print_status "Check logs with: sudo journalctl -u elementpay_ussd.service -f"
print_status "Test endpoint with: curl -X POST http://localhost:8002/ussd/"

# Show service status
echo ""
print_status "Service Status:"
systemctl status elementpay_ussd.service --no-pager -l

echo ""
print_success "🎉 USSD service deployed and running!"
