
import os
from langchain_google_genai import ChatGoogleGenerativeAI
from dotenv import load_dotenv

# Load the user's Project Keys
load_dotenv(".env")

api_key = os.getenv("GOOGLE_API_KEY")
model_name = "gemini-3-pro-preview"

print(f"Testing connectivity with Key: {api_key[:5]}...{api_key[-5:]}")
print(f"Target Model: {model_name}")

try:
    llm = ChatGoogleGenerativeAI(
        model=model_name,
        google_api_key=api_key
    )
    result = llm.invoke("Hello, are you online?")
    print(f"SUCCESS: {result.content}")
except Exception as e:
    print(f"FAILURE: {e}")
