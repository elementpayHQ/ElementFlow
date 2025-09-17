#!/usr/bin/env python3
"""
ElementPay USSD Service - Fixed Version
This fixes the redirect loop issue you're experiencing
"""

from fastapi import FastAPI, Form, Request, Response
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import os
from typing import Optional
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create FastAPI app with redirect handling disabled
app = FastAPI(
    title="ElementPay USSD Service",
    description="USSD service for ElementPay mobile money",
    version="1.0.0",
    redirect_slashes=False  # This prevents automatic redirects
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# USSD Session Management (in-memory for now, use Redis in production)
ussd_sessions = {}

class USSDSession:
    def __init__(self, session_id: str, phone_number: str):
        self.session_id = session_id
        self.phone_number = phone_number
        self.current_menu = "main"
        self.data = {}
        self.created_at = None

def get_main_menu():
    """Main USSD menu"""
    return """CON Welcome to ElementPay
1. Check Balance
2. Send Money
3. Buy Airtime
4. Pay Bills
5. My Account
0. Exit"""

def get_balance_menu():
    """Balance check menu"""
    return """CON Your Account Balance
Available: $150.00
Pending: $25.50

1. Back to Main Menu
0. Exit"""

def get_send_money_menu():
    """Send money menu"""
    return """CON Send Money
Enter recipient phone number:
(Format: 1234567890)"""

def get_airtime_menu():
    """Buy airtime menu"""
    return """CON Buy Airtime
1. For Myself
2. For Others
3. Back to Main Menu
0. Exit"""

def get_bills_menu():
    """Pay bills menu"""
    return """CON Pay Bills
1. Electricity
2. Water
3. Internet
4. Back to Main Menu
0. Exit"""

def get_account_menu():
    """Account menu"""
    return """CON My Account
1. Transaction History
2. Change PIN
3. Account Settings
4. Back to Main Menu
0. Exit"""

def process_ussd_input(session_id: str, phone_number: str, text: str) -> str:
    """
    Process USSD input and return appropriate response
    """
    # Get or create session
    if session_id not in ussd_sessions:
        ussd_sessions[session_id] = USSDSession(session_id, phone_number)
    
    session = ussd_sessions[session_id]
    
    # Handle empty text (first request)
    if not text:
        session.current_menu = "main"
        return get_main_menu()
    
    # Split text into menu selections
    selections = text.split('*')
    current_selection = selections[-1] if selections else ""
    
    logger.info(f"Session: {session_id}, Phone: {phone_number}, Text: '{text}', Current Menu: {session.current_menu}")
    
    # Route based on current menu
    if session.current_menu == "main":
        return handle_main_menu(session, current_selection)
    elif session.current_menu == "balance":
        return handle_balance_menu(session, current_selection)
    elif session.current_menu == "send_money":
        return handle_send_money_menu(session, current_selection, text)
    elif session.current_menu == "airtime":
        return handle_airtime_menu(session, current_selection)
    elif session.current_menu == "bills":
        return handle_bills_menu(session, current_selection)
    elif session.current_menu == "account":
        return handle_account_menu(session, current_selection)
    else:
        session.current_menu = "main"
        return get_main_menu()

def handle_main_menu(session: USSDSession, selection: str) -> str:
    """Handle main menu selections"""
    if selection == "1":
        session.current_menu = "balance"
        return get_balance_menu()
    elif selection == "2":
        session.current_menu = "send_money"
        return get_send_money_menu()
    elif selection == "3":
        session.current_menu = "airtime"
        return get_airtime_menu()
    elif selection == "4":
        session.current_menu = "bills"
        return get_bills_menu()
    elif selection == "5":
        session.current_menu = "account"
        return get_account_menu()
    elif selection == "0":
        return "END Thank you for using ElementPay. Goodbye!"
    else:
        return "CON Invalid selection. Please try again.\n" + get_main_menu()

def handle_balance_menu(session: USSDSession, selection: str) -> str:
    """Handle balance menu selections"""
    if selection == "1":
        session.current_menu = "main"
        return get_main_menu()
    elif selection == "0":
        return "END Thank you for using ElementPay. Goodbye!"
    else:
        return "CON Invalid selection. Please try again.\n" + get_balance_menu()

def handle_send_money_menu(session: USSDSession, selection: str, full_text: str) -> str:
    """Handle send money menu"""
    if not selection or selection == "":
        return "CON Enter recipient phone number:"
    
    # Check if we have a phone number
    if len(selection) >= 10 and selection.isdigit():
        session.data['recipient'] = selection
        session.current_menu = "send_amount"
        return "CON Enter amount to send:"
    else:
        return "CON Invalid phone number. Please enter a valid 10-digit number:"

def handle_airtime_menu(session: USSDSession, selection: str) -> str:
    """Handle airtime menu selections"""
    if selection == "1":
        return "CON Enter airtime amount:"
    elif selection == "2":
        return "CON Enter recipient phone number:"
    elif selection == "3":
        session.current_menu = "main"
        return get_main_menu()
    elif selection == "0":
        return "END Thank you for using ElementPay. Goodbye!"
    else:
        return "CON Invalid selection. Please try again.\n" + get_airtime_menu()

def handle_bills_menu(session: USSDSession, selection: str) -> str:
    """Handle bills menu selections"""
    if selection in ["1", "2", "3"]:
        return "CON Enter account number:"
    elif selection == "4":
        session.current_menu = "main"
        return get_main_menu()
    elif selection == "0":
        return "END Thank you for using ElementPay. Goodbye!"
    else:
        return "CON Invalid selection. Please try again.\n" + get_bills_menu()

def handle_account_menu(session: USSDSession, selection: str) -> str:
    """Handle account menu selections"""
    if selection == "1":
        return "CON Your last 5 transactions:\n1. Send $50 to 1234567890\n2. Received $25 from 0987654321\n3. Airtime $10\n4. Electricity $45\n5. Back"
    elif selection == "2":
        return "CON Enter new PIN:"
    elif selection == "3":
        return "CON Account Settings:\n1. Language\n2. Notifications\n3. Back"
    elif selection == "4":
        session.current_menu = "main"
        return get_main_menu()
    elif selection == "0":
        return "END Thank you for using ElementPay. Goodbye!"
    else:
        return "CON Invalid selection. Please try again.\n" + get_account_menu()

@app.post("/ussd/")
@app.get("/ussd/")
async def ussd_handler(
    request: Request,
    sessionId: Optional[str] = Form(None),
    serviceCode: Optional[str] = Form(None),
    phoneNumber: Optional[str] = Form(None),
    text: Optional[str] = Form("")
):
    """
    Main USSD endpoint - handles both POST and GET requests
    """
    try:
        # Log the request for debugging
        logger.info(f"USSD Request - Method: {request.method}")
        logger.info(f"Headers: {dict(request.headers)}")
        
        # Handle both form data and query parameters
        if request.method == "POST":
            form_data = await request.form()
            session_id = form_data.get("sessionId", "")
            service_code = form_data.get("serviceCode", "")
            phone_number = form_data.get("phoneNumber", "")
            ussd_text = form_data.get("text", "")
        else:
            # GET request - extract from query parameters
            session_id = request.query_params.get("sessionId", "")
            service_code = request.query_params.get("serviceCode", "")
            phone_number = request.query_params.get("phoneNumber", "")
            ussd_text = request.query_params.get("text", "")
        
        # Validate required parameters
        if not session_id or not phone_number:
            logger.error(f"Missing required parameters: sessionId={session_id}, phoneNumber={phone_number}")
            return PlainTextResponse(
                content="END Invalid request. Missing required parameters.",
                media_type="text/plain"
            )
        
        # Process USSD request
        response = process_ussd_input(session_id, phone_number, ussd_text)
        
        logger.info(f"USSD Response: {response[:100]}...")
        
        return PlainTextResponse(
            content=response,
            media_type="text/plain"
        )
        
    except Exception as e:
        logger.error(f"Error processing USSD request: {str(e)}")
        return PlainTextResponse(
            content="END An error occurred. Please try again later.",
            media_type="text/plain"
        )

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "ElementPay USSD"}

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "message": "ElementPay USSD Service",
        "version": "1.0.0",
        "endpoints": {
            "ussd": "/ussd/",
            "health": "/health"
        }
    }

if __name__ == "__main__":
    # Get port from environment or default to 8002
    port = int(os.getenv("PORT", 8002))
    host = os.getenv("HOST", "0.0.0.0")
    
    logger.info(f"Starting ElementPay USSD Service on {host}:{port}")
    
    uvicorn.run(
        "ussd_service_fix:app",
        host=host,
        port=port,
        reload=True,
        log_level="info"
    )
