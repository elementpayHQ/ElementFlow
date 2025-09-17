#!/bin/bash

# USSD Endpoint Test Script
# This script tests the USSD service to ensure it's working correctly

echo "🧪 Testing ElementPay USSD Service"
echo "=================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

print_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Test 1: Health Check
print_status "Test 1: Health Check"
HEALTH_RESPONSE=$(curl -s http://localhost:8002/health)
if [[ $? -eq 0 ]]; then
    print_success "Health endpoint is accessible"
    echo "Response: $HEALTH_RESPONSE"
else
    print_error "Health endpoint failed"
fi
echo ""

# Test 2: Root Endpoint
print_status "Test 2: Root Endpoint"
ROOT_RESPONSE=$(curl -s http://localhost:8002/)
if [[ $? -eq 0 ]]; then
    print_success "Root endpoint is accessible"
    echo "Response: $ROOT_RESPONSE"
else
    print_error "Root endpoint failed"
fi
echo ""

# Test 3: USSD POST Request (Initial Menu)
print_status "Test 3: USSD POST Request - Initial Menu"
POST_RESPONSE=$(curl -s -X POST http://localhost:8002/ussd/ \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sessionId=test123&serviceCode=*123#&phoneNumber=1234567890&text=" \
  -w "\nHTTP Status: %{http_code}")

HTTP_STATUS=$(echo "$POST_RESPONSE" | tail -n1 | grep -o '[0-9]*$')
RESPONSE_BODY=$(echo "$POST_RESPONSE" | head -n -1)

if [[ "$HTTP_STATUS" == "200" ]]; then
    print_success "USSD POST request successful (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
else
    print_error "USSD POST request failed (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
fi
echo ""

# Test 4: USSD GET Request (Initial Menu)
print_status "Test 4: USSD GET Request - Initial Menu"
GET_RESPONSE=$(curl -s -X GET "http://localhost:8002/ussd/?sessionId=test456&serviceCode=*123#&phoneNumber=1234567890&text=" \
  -w "\nHTTP Status: %{http_code}")

HTTP_STATUS=$(echo "$GET_RESPONSE" | tail -n1 | grep -o '[0-9]*$')
RESPONSE_BODY=$(echo "$GET_RESPONSE" | head -n -1)

if [[ "$HTTP_STATUS" == "200" ]]; then
    print_success "USSD GET request successful (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
else
    print_error "USSD GET request failed (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
fi
echo ""

# Test 5: USSD Menu Navigation (Select Option 1)
print_status "Test 5: USSD Menu Navigation - Select Balance"
NAV_RESPONSE=$(curl -s -X POST http://localhost:8002/ussd/ \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sessionId=test789&serviceCode=*123#&phoneNumber=1234567890&text=1" \
  -w "\nHTTP Status: %{http_code}")

HTTP_STATUS=$(echo "$NAV_RESPONSE" | tail -n1 | grep -o '[0-9]*$')
RESPONSE_BODY=$(echo "$NAV_RESPONSE" | head -n -1)

if [[ "$HTTP_STATUS" == "200" ]]; then
    print_success "USSD navigation successful (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
else
    print_error "USSD navigation failed (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
fi
echo ""

# Test 6: Invalid Request (Missing Parameters)
print_status "Test 6: Invalid Request - Missing Parameters"
INVALID_RESPONSE=$(curl -s -X POST http://localhost:8002/ussd/ \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sessionId=&phoneNumber=" \
  -w "\nHTTP Status: %{http_code}")

HTTP_STATUS=$(echo "$INVALID_RESPONSE" | tail -n1 | grep -o '[0-9]*$')
RESPONSE_BODY=$(echo "$INVALID_RESPONSE" | head -n -1)

if [[ "$HTTP_STATUS" == "200" ]]; then
    print_success "Invalid request handled correctly (Status: $HTTP_STATUS)"
    echo "Response: $RESPONSE_BODY"
else
    print_warning "Invalid request returned unexpected status: $HTTP_STATUS"
    echo "Response: $RESPONSE_BODY"
fi
echo ""

# Test 7: Check for Redirect Loops
print_status "Test 7: Checking for Redirect Loops"
REDIRECT_CHECK=$(curl -s -I -X POST http://localhost:8002/ussd/ \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sessionId=test999&serviceCode=*123#&phoneNumber=1234567890&text=" \
  -w "%{http_code}")

if [[ "$REDIRECT_CHECK" == *"307"* ]]; then
    print_error "REDIRECT LOOP DETECTED! Status 307 found"
else
    print_success "No redirect loops detected"
fi
echo ""

# Summary
echo "=================================="
echo "🧪 Test Summary"
echo "=================================="

# Count successes and failures
TOTAL_TESTS=7
PASSED_TESTS=$(grep -c "\[PASS\]" <<< "$(cat $0)")
FAILED_TESTS=$(grep -c "\[FAIL\]" <<< "$(cat $0)")

echo "Total Tests: $TOTAL_TESTS"
echo "Passed: $PASSED_TESTS"
echo "Failed: $FAILED_TESTS"

if [[ $FAILED_TESTS -eq 0 ]]; then
    echo ""
    print_success "🎉 All tests passed! USSD service is working correctly."
else
    echo ""
    print_warning "⚠️  Some tests failed. Check the output above for details."
fi

echo ""
echo "📋 Manual Testing Commands:"
echo "curl -X POST http://localhost:8002/ussd/ -H 'Content-Type: application/x-www-form-urlencoded' -d 'sessionId=test123&serviceCode=*123#&phoneNumber=1234567890&text='"
echo "curl -X GET 'http://localhost:8002/ussd/?sessionId=test456&serviceCode=*123#&phoneNumber=1234567890&text='"
echo "curl -X GET http://localhost:8002/health"
