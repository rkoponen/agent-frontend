import { useState, useRef, useEffect } from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

// Extend Window interface for speech recognition
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: (event: any) => void;
  onerror: (event: any) => void;
  onend: () => void;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const [voiceMode, setVoiceMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);
  const responseTextRef = useRef<string>("");
  const voiceModeRef = useRef<boolean>(false);
  const shouldContinueListeningRef = useRef<boolean>(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Initialize speech recognition
  useEffect(() => {
    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current!.continuous = false;
      recognitionRef.current!.interimResults = false;
      recognitionRef.current!.lang = "en-US";

      recognitionRef.current!.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setTranscript(transcript);
        setIsListening(false);
        // Automatically send the transcribed message
        sendVoiceMessage(transcript);
      };

      recognitionRef.current!.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
      };

      recognitionRef.current!.onend = () => {
        setIsListening(false);
      };
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (synthRef.current) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const startListening = () => {
    if (recognitionRef.current && !isListening && !isLoading) {
      setTranscript("");
      shouldContinueListeningRef.current = true;
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  };

  const speak = (text: string) => {
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onstart = () => {
      setIsSpeaking(true);
    };

    utterance.onend = () => {
      setIsSpeaking(false);
      // Automatically start listening again after agent finishes speaking
      if (voiceModeRef.current && shouldContinueListeningRef.current) {
        setTimeout(() => {
          if (recognitionRef.current && shouldContinueListeningRef.current) {
            setTranscript("");
            recognitionRef.current.start();
            setIsListening(true);
          }
        }, 500); // Small delay before starting to listen again
      }
    };

    utterance.onerror = (event) => {
      console.error("Speech synthesis error:", event);
      setIsSpeaking(false);
      // Still try to restart listening even if there was an error
      if (voiceModeRef.current && shouldContinueListeningRef.current) {
        setTimeout(() => {
          if (recognitionRef.current && shouldContinueListeningRef.current) {
            setTranscript("");
            recognitionRef.current.start();
            setIsListening(true);
          }
        }, 500);
      }
    };

    synthRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  const stopSpeaking = () => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  const stopConversation = () => {
    shouldContinueListeningRef.current = false;
    stopSpeaking();
    stopListening();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsLoading(false);
    setTranscript("");
    responseTextRef.current = "";
  };

  const sendVoiceMessage = async (messageText: string) => {
    if (!messageText.trim() || isLoading) return;

    setIsLoading(true);
    responseTextRef.current = "";

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";

    try {
      const response = await fetch(`${apiUrl}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: messageText,
          sessionId: sessionId,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No reader available");
      }

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));

            if (data.done) {
              // Stream complete - speak the full response
              if (responseTextRef.current) {
                speak(responseTextRef.current);
              }
              break;
            }

            if (data.error) {
              throw new Error(data.error);
            }

            if (data.content) {
              responseTextRef.current += data.content;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      const errorMessage = `Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      speak(errorMessage);
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    // Create a placeholder message for streaming
    const assistantMessageId = (Date.now() + 1).toString();

    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, assistantMessage]);

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";

    try {
      const response = await fetch(`${apiUrl}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: userMessage.content,
          sessionId: sessionId,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No reader available");
      }

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));

            if (data.done) {
              // Stream complete
              break;
            }

            if (data.error) {
              throw new Error(data.error);
            }

            if (data.content) {
              // Update the streaming message with new content
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? {
                        ...msg,
                        content: msg.content + data.content,
                      }
                    : msg
                )
              );
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Request was cancelled
        return;
      }

      const errorMessage = `Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;

      // Update the streaming message with error
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: errorMessage,
              }
            : msg
        )
      );
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  const clearChat = () => {
    // Cancel any ongoing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setMessages([]);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 p-4 shadow-sm">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">
            Car Agent
          </h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const newMode = !voiceMode;
                setVoiceMode(newMode);
                voiceModeRef.current = newMode;
                shouldContinueListeningRef.current = false;
                if (newMode) {
                  // Switching to voice mode - clear text messages
                  setMessages([]);
                } else {
                  // Switching to text mode - stop all voice activities
                  stopConversation();
                }
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                voiceMode
                  ? "bg-green-500 text-white hover:bg-green-600"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {voiceMode ? "🎤 Voice Mode" : "💬 Text Mode"}
            </button>
            {!voiceMode && (
              <button
                onClick={clearChat}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Clear Chat
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      {voiceMode ? (
        /* Voice Mode Interface */
        <main className="flex-1 flex items-center justify-center bg-linear-to-br from-blue-50 to-purple-50">
          <div className="text-center p-8">
            <div className="mb-8">
              <div
                className={`inline-flex items-center justify-center w-48 h-48 rounded-full transition-all duration-300 ${
                  isListening
                    ? "bg-red-500 shadow-lg shadow-red-300 animate-pulse"
                    : isSpeaking
                    ? "bg-blue-500 shadow-lg shadow-blue-300 animate-pulse"
                    : isLoading
                    ? "bg-yellow-500 shadow-lg shadow-yellow-300 animate-pulse"
                    : "bg-green-500 shadow-lg shadow-green-300"
                }`}
              >
                {isListening ? (
                  <svg
                    className="w-24 h-24 text-white"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                  </svg>
                ) : isSpeaking ? (
                  <svg
                    className="w-24 h-24 text-white"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                  </svg>
                ) : isLoading ? (
                  <svg
                    className="w-24 h-24 text-white animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-24 h-24 text-white"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                  </svg>
                )}
              </div>
            </div>

            <h2 className="text-3xl font-bold text-gray-800 mb-4">
              {isListening
                ? "Listening..."
                : isSpeaking
                ? "Speaking..."
                : isLoading
                ? "Thinking..."
                : "Ready to chat"}
            </h2>

            {transcript && (
              <div className="mb-6 p-4 bg-white rounded-lg shadow-md max-w-2xl mx-auto">
                <p className="text-gray-600 text-sm mb-1">You said:</p>
                <p className="text-gray-800 text-lg">{transcript}</p>
              </div>
            )}

            {responseTextRef.current && isSpeaking && (
              <div className="mb-6 p-4 bg-blue-50 rounded-lg shadow-md max-w-2xl mx-auto">
                <p className="text-blue-600 text-sm mb-1">Agent:</p>
                <p className="text-gray-800 text-lg">
                  {responseTextRef.current}
                </p>
              </div>
            )}

            <div className="flex gap-4 justify-center items-center">
              {!isListening && !isLoading && !isSpeaking && (
                <button
                  onClick={startListening}
                  className="px-8 py-4 bg-green-500 text-white font-semibold rounded-full hover:bg-green-600 transition-colors shadow-lg hover:shadow-xl transform hover:scale-105"
                >
                  Start Talking
                </button>
              )}

              {(isListening || isLoading || isSpeaking) && (
                <button
                  onClick={stopConversation}
                  className="px-8 py-4 bg-red-500 text-white font-semibold rounded-full hover:bg-red-600 transition-colors shadow-lg hover:shadow-xl"
                >
                  Stop Conversation
                </button>
              )}
            </div>

            <p className="mt-8 text-gray-500 text-sm">
              {isListening
                ? "Speak clearly into your microphone"
                : isSpeaking
                ? "Listening to the agent's response"
                : isLoading
                ? "Processing your request"
                : "Click 'Start Talking' and ask about our menu or place an order"}
            </p>

            {!(
              "webkitSpeechRecognition" in window ||
              "SpeechRecognition" in window
            ) && (
              <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg max-w-2xl mx-auto">
                <p className="text-yellow-800 text-sm">
                  ⚠️ Speech recognition is not supported in your browser. Please
                  use Chrome, Edge, or Safari.
                </p>
              </div>
            )}
          </div>
        </main>
      ) : (
        /* Text Mode Interface */
        <>
          <main className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto p-4 space-y-4">
              {messages.length === 0 ? (
                <div className="text-center py-12">
                  <div className="inline-block p-4 bg-blue-50 rounded-full mb-4">
                    <svg
                      className="w-12 h-12 text-blue-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                      />
                    </svg>
                  </div>
                  <h2 className="text-xl font-semibold text-gray-700 mb-2">
                    Start a conversation
                  </h2>
                  <p className="text-gray-500">
                    Order food, find parking and plan your trips
                  </p>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${
                      message.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[70%] rounded-lg p-4 ${
                        message.role === "user"
                          ? "bg-blue-500 text-white"
                          : "bg-white text-gray-800 border border-gray-200"
                      }`}
                    >
                      <p className="whitespace-pre-wrap wrap-break-word">
                        {message.content}
                      </p>
                      <span
                        className={`text-xs mt-2 block ${
                          message.role === "user"
                            ? "text-blue-100"
                            : "text-gray-400"
                        }`}
                      >
                        {message.timestamp.toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))
              )}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-white border border-gray-200 rounded-lg p-4">
                    <div className="flex space-x-2">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                      <div
                        className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                        style={{ animationDelay: "0.1s" }}
                      />
                      <div
                        className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                        style={{ animationDelay: "0.2s" }}
                      />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </main>

          {/* Input Form */}
          <footer className="bg-white border-t border-gray-200 p-4">
            <form onSubmit={sendMessage} className="max-w-4xl mx-auto">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder=""
                  disabled={isLoading}
                  className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
                <button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="px-6 py-3 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoading ? "Sending..." : "Send"}
                </button>
              </div>
            </form>
          </footer>
        </>
      )}
    </div>
  );
}

export default App;
