"""
LLM 인스턴스 정의
모델 교체 시 이 파일만 수정
"""

from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI

load_dotenv()

llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash")
