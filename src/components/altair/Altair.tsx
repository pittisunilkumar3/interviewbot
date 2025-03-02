/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { useEffect, useRef, useState, memo, useCallback } from "react";
import vegaEmbed from "vega-embed";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { useWebcam } from "../../hooks/use-webcam";
import { PROCTOR_PROMPT, TERMINATION_PROMPT } from "./ProctorPrompt";
import { ToolCall } from "../../multimodal-live-types";

interface InterviewQA {
  category: string;
  question: string;
  answer: string;
  timestamp: string;
  evaluation: {
    score: number;
    feedback: string;
    key_points_covered: string[];
    missing_points: string[];
    strengths: string[];
    areas_for_improvement: string[];
  };
}

interface TechnicalEvaluation {
  category_scores: {
    Python_Fundamentals: number;
    Web_Development: number;
    Database: number;
    Testing: number;
    Python_Ecosystem: number;
  };
  overall_score: number;
}

interface InterviewProgress {
  completed_categories: string[];
  current_category: string;
  questions_remaining: number;
  average_score: number;
  is_complete?: boolean;
  end_time?: string;
  duration_seconds?: number;
  termination_reason?: string;
}

interface InterviewSession {
  candidate: {
    name: string;
    position: string;
    years_of_experience: number;
  };
  session: {
    timestamp: string;
    duration: number;
    completed_categories: string[];
  };
  qa_history: InterviewQA[];
  qa_pairs: Record<string, InterviewQA[]>;
  progress: InterviewProgress;
  technical_evaluation: TechnicalEvaluation;
  proctorLog?: Array<{ timestamp: string; action: string; }>;
  final_evaluation?: {
    technical_score: number;
    sentiment_analysis: {
      confidence: number;
      overall_sentiment: string;
      key_indicators: string[];
      communication_score: number;
      technical_confidence: number;
    };
    recommendation: {
      hire_recommendation: boolean;
      justification: string;
      strengths: string[];
      areas_for_improvement: string[];
      suggested_role_level: string;
    };
  };
}

const INTERVIEW_CATEGORIES = [
  'Python_Fundamentals',
  'Web_Development',
  'Database',
  'Testing',
  'Python_Ecosystem'
];

const INITIAL_TECHNICAL_EVALUATION: TechnicalEvaluation = {
  category_scores: {
    Python_Fundamentals: 0,
    Web_Development: 0,
    Database: 0,
    Testing: 0,
    Python_Ecosystem: 0
  },
  overall_score: 0
};

const INITIAL_PROGRESS: InterviewProgress = {
  completed_categories: [],
  current_category: INTERVIEW_CATEGORIES[0],
  questions_remaining: 15, // 3 questions per category
  average_score: 0
};

const declaration: FunctionDeclaration = {
  name: "render_altair",
  description: "Displays an altair graph in json format.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      json_graph: {
        type: SchemaType.STRING,
        description:
          "JSON STRING representation of the graph to render. Must be a string, not a json object",
      },
    },
    required: ["json_graph"],
  },
};

// Proctor interview tool declaration
const proctorDeclaration: FunctionDeclaration = {
  name: "proctor_interview",
  description: "Monitors the candidate during the interview for compliance with proctoring rules",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      action: {
        type: SchemaType.STRING,
        description: "The action to take: 'check_status', 'issue_warning', or 'terminate'",
        enum: ["check_status", "issue_warning", "terminate"]
      },
      reason: {
        type: SchemaType.STRING,
        description: "The reason for issuing a warning or terminating the interview",
      },
    },
    required: ["action"],
  },
};

// Helper function to validate and ensure state consistency
const validateState = (state: InterviewSession): InterviewSession => {
  // Create a deep copy to avoid mutation
  const validatedState = JSON.parse(JSON.stringify(state));
  
  // Ensure all required properties exist
  if (!validatedState.candidate) {
    validatedState.candidate = {
      name: "",
      position: "",
      years_of_experience: 0
    };
  }
  
  if (!validatedState.session) {
    validatedState.session = {
      timestamp: new Date().toISOString(),
      duration: 0,
      completed_categories: []
    };
  }
  
  if (!validatedState.qa_history) {
    validatedState.qa_history = [];
  }
  
  if (!validatedState.qa_pairs) {
    validatedState.qa_pairs = {};
  }
  
  if (!validatedState.progress) {
    validatedState.progress = INITIAL_PROGRESS;
  }
  
  if (!validatedState.technical_evaluation) {
    validatedState.technical_evaluation = INITIAL_TECHNICAL_EVALUATION;
  }
  
  return validatedState;
};

function AltairComponent() {
  const { stream, isStreaming } = useWebcam();
  const [jsonString, setJSONString] = useState<string>("");
  const [isProctorActive, setIsProctorActive] = useState(false);
  const [proctorWarnings, setProctorWarnings] = useState<string[]>([]);
  const [isInterviewTerminated, setIsInterviewTerminated] = useState(false);
  const [proctorSessionActive, setProctorSessionActive] = useState(false);
  const [cameraVerificationAttempts, setCameraVerificationAttempts] = useState(0);
  const maxCameraAttempts = 3;
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoCheckIntervalRef = useRef<number | null>(null);
  const startTimeRef = useRef(new Date());
  const embedRef = useRef<HTMLDivElement>(null);
  const { client, setConfig } = useLiveAPIContext();
  const [interviewSession, setInterviewSession] = useState<InterviewSession>({
    candidate: {
      name: "",
      position: "",
      years_of_experience: 0
    },
    session: {
      timestamp: new Date().toISOString(),
      duration: 0,
      completed_categories: []
    },
    qa_history: [],
    qa_pairs: {},
    progress: INITIAL_PROGRESS,
    technical_evaluation: INITIAL_TECHNICAL_EVALUATION
  });

  // Log user actions for proctoring
  const logUserAction = useCallback((action: string) => {
    const timestamp = new Date().toISOString();
    console.log(`[PROCTOR LOG ${timestamp}] ${action}`);
    
    setInterviewSession(prev => ({
      ...prev,
      proctorLog: [...(prev.proctorLog || []), { timestamp, action }]
    }));
  }, []);

  const issueWarning = useCallback((message: string) => {
    setProctorWarnings(prev => [...prev, message]);
    logUserAction(`Warning issued to candidate: ${message}`);
    console.warn(`Warning issued: ${message}`);
  }, [logUserAction]);

  const stopProctoring = useCallback(() => {
    if (videoCheckIntervalRef.current) {
      clearInterval(videoCheckIntervalRef.current);
      videoCheckIntervalRef.current = null;
    }
    setIsProctorActive(false);
    logUserAction("Proctoring stopped");
    console.log("Proctoring stopped");
  }, [logUserAction]);

  const checkCandidatePresence = useCallback(() => {
    if (!stream || !isStreaming) {
      console.log("Video feed check: not available");
      if (isProctorActive) {
        logUserAction("Video feed unavailable during active session");
      }
      return;
    }
    
    const videoTracks = stream.getVideoTracks();
    const isVideoEnabled = videoTracks.length > 0 && videoTracks[0].enabled && videoTracks[0].readyState === "live";
    
    if (!isVideoEnabled) {
      console.log("Video feed check: video is disabled or not active");
      if (isProctorActive) {
        logUserAction("Video track disabled during active session");
      }
      return;
    }
    
    if (isProctorActive && videoRef.current) {
      if (videoRef.current.paused || videoRef.current.ended) {
        logUserAction("Video playback stopped or ended");
      }
    }
  }, [stream, isStreaming, isProctorActive, logUserAction]);

  const startProctoring = useCallback(() => {
    if (!isProctorActive && stream && videoRef.current) {
      setIsProctorActive(true);
      
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
        logUserAction("Proctoring started - Camera connected");
      }
      
      videoCheckIntervalRef.current = window.setInterval(() => {
        checkCandidatePresence();
      }, 1000) as unknown as number;
      
      console.log("Proctoring started with active camera checking");
    } else {
      console.log("Cannot start proctoring: camera not available");
      logUserAction("Proctoring failed to start - No camera available");
    }
  }, [isProctorActive, stream, logUserAction, checkCandidatePresence]);

  const terminateInterview = useCallback((reason: string) => {
    setIsInterviewTerminated(true);
    stopProctoring();
    
    logUserAction(`Interview terminated: ${reason}`);
    
    setInterviewSession(prev => ({
      ...prev,
      progress: {
        ...prev.progress,
        is_complete: true,
        end_time: new Date().toISOString(),
        termination_reason: reason
      }
    }));
    
    console.error(`Interview terminated: ${reason}`);
    
    setConfig({
      model: "models/gemini-2.0-flash-exp",
      systemInstruction: {
        parts: [{
          text: `
            ${TERMINATION_PROMPT}
            
            The interview has been terminated for the following reason: "${reason}"
            
            Please inform the candidate clearly and professionally.
          `
        }]
      },
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [
            declaration,
            proctorDeclaration,
            {
              name: "set_candidate_info",
              description: "Sets the candidate's basic information",
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  name: { type: SchemaType.STRING, description: "Candidate's name" },
                  position: { type: SchemaType.STRING, description: "Position being interviewed for" }
                },
                required: ["name", "position"]
              }
            },
            {
              name: "store_qa",
              description: "Stores a question and answer pair with detailed evaluation",
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  question: { type: SchemaType.STRING, description: "Technical question asked to the candidate" },
                  answer: { type: SchemaType.STRING, description: "Candidate's detailed response" },
                  evaluation: {
                    type: SchemaType.OBJECT,
                    properties: {
                      score: { type: SchemaType.NUMBER, description: "Technical accuracy score (1-10)" },
                      feedback: { type: SchemaType.STRING, description: "Detailed evaluation feedback" },
                      key_points_covered: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Key technical points correctly addressed"
                      },
                      missing_points: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Important points that were missed"
                      },
                      strengths: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Strong aspects of the answer"
                      },
                      areas_for_improvement: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Areas needing improvement"
                      }
                    },
                    required: ["score", "feedback", "key_points_covered", "missing_points", "strengths", "areas_for_improvement"]
                  }
                },
                required: ["question", "answer", "evaluation"]
              }
            },
            {
              name: "verify_camera",
              description: "Verifies if camera is enabled and video feed is visible",
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  status: { type: SchemaType.BOOLEAN, description: "Current camera status" },
                  message: { type: SchemaType.STRING, description: "Status message or instructions" }
                },
                required: ["status", "message"]
              }
            },
            {
              name: "complete_interview",
              description: "Generates comprehensive final evaluation",
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  technical_score: { type: SchemaType.NUMBER, description: "Overall technical proficiency score (1-10)" },
                  sentiment_analysis: {
                    type: SchemaType.OBJECT,
                    properties: {
                      confidence: { type: SchemaType.NUMBER, description: "Confidence level in assessment (0-1)" },
                      overall_sentiment: { type: SchemaType.STRING, description: "Overall sentiment analysis (positive/neutral/negative)" },
                      key_indicators: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Key behavioral and communication indicators"
                      },
                      communication_score: { type: SchemaType.NUMBER, description: "Communication effectiveness score (1-10)" },
                      technical_confidence: { type: SchemaType.NUMBER, description: "Confidence in technical responses (1-10)" }
                    },
                    required: ["confidence", "overall_sentiment", "key_indicators", "communication_score", "technical_confidence"]
                  },
                  recommendation: {
                    type: SchemaType.OBJECT,
                    properties: {
                      hire_recommendation: { type: SchemaType.BOOLEAN, description: "Whether to hire the candidate" },
                      justification: { type: SchemaType.STRING, description: "Detailed justification for the recommendation" },
                      strengths: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Key strengths demonstrated"
                      },
                      areas_for_improvement: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING },
                        description: "Areas needing improvement"
                      },
                      suggested_role_level: { type: SchemaType.STRING, description: "Suggested role level (Junior/Mid-Level/Senior)" }
                    },
                    required: ["hire_recommendation", "justification", "strengths", "areas_for_improvement", "suggested_role_level"]
                  }
                },
                required: ["technical_score", "sentiment_analysis", "recommendation"]
              }
            }
          ]
        }
      ]
    });
  }, [logUserAction, stopProctoring, setConfig]);

  useEffect(() => {
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    const onToolCall = (toolCall: ToolCall) => {
      if (isDevelopment) {
        console.log(`Tool called: ${toolCall.functionCalls.map(fc => fc.name).join(', ')}`);
      }
      
      toolCall.functionCalls.forEach((fc) => {
        if (fc.name === "render_altair") {
          const str = (fc.args as any).json_graph;
          setJSONString(str);
          
          if (isDevelopment) {
            console.log(`Rendering Altair graph`);
          }
        } else if (fc.name === "set_candidate_info") {
          const { name, position } = fc.args as any;
          setInterviewSession(prev => {
            const updatedState = {
              ...prev,
              candidate: { 
                name, 
                position,
                years_of_experience: 2 // Default to 2 years as per requirement
              }
            };
            
            if (isDevelopment) {
              console.log('Updated candidate info:', { name, position });
            }
            
            return validateState(updatedState);
          });
        } else if (fc.name === "store_qa") {
          const { question, answer, evaluation } = fc.args as any;
          const currentCategory = interviewSession.progress.current_category;
          
          const qaEntry: InterviewQA = {
            category: currentCategory,
            question,
            answer,
            timestamp: new Date().toISOString(),
            evaluation: evaluation || null
          };
          
          setInterviewSession(prev => {
            // Create a copy of the previous state
            const updatedState = { ...prev };
            
            // Add the QA entry to the appropriate category
            if (!updatedState.qa_pairs[currentCategory]) {
              updatedState.qa_pairs[currentCategory] = [];
            }
            updatedState.qa_pairs[currentCategory].push(qaEntry);
            
            // Only log minimal information in development mode
            if (isDevelopment) {
              console.log(`Stored Q&A for category: ${currentCategory}`);
            }
            
            return validateState(updatedState);
          });
        } else if (fc.name === "verify_camera") {
          // Properly verify camera stream and tracks
          const hasActiveStream = stream !== null && isStreaming;
          const hasVideoTracks = stream?.getVideoTracks().some(track => track.enabled && track.readyState === "live") || false;
          
          const status = hasActiveStream && hasVideoTracks;
          let message = "";
          
          if (!status) {
            // Increment attempt counter when verification fails
            setCameraVerificationAttempts(prev => prev + 1);
            
            if (cameraVerificationAttempts >= maxCameraAttempts) {
              logUserAction(`Multiple camera verification failures (${cameraVerificationAttempts} attempts)`);
            }
          } else {
            // Reset counter when camera is successfully verified
            setCameraVerificationAttempts(0);
            
            // Start proctoring if not already active
            if (!isProctorActive && !proctorSessionActive) {
              startProctoring();
              setProctorSessionActive(true);
            }
          }
          
          if (!stream) {
            message = "Camera access not granted. Please enable your camera in browser settings.";
            logUserAction("Camera access not granted");
          } else if (!isStreaming) {
            message = "Camera stream is not active. Please check your camera settings.";
            logUserAction("Camera stream inactive");
          } else if (!hasVideoTracks) {
            message = "No active video tracks detected. Please ensure your camera is not being used by another application.";
            logUserAction("No active video tracks");
          } else {
            message = "Camera is working properly.";
            logUserAction("Camera verified successfully");
          }
          
          // Log actual camera status
          if (isDevelopment) {
            console.log(`Camera status: ${status ? 'OK' : 'Issue detected'}`, {
              hasStream: stream !== null,
              isStreaming,
              hasVideoTracks,
              verificationAttempts: cameraVerificationAttempts
            });
          }

          client.sendToolResponse({
            functionResponses: [{
              response: {
                output: {
                  status,
                  message,
                  details: {
                    hasStream: stream !== null,
                    isStreaming,
                    hasVideoTracks
                  }
                }
              },
              id: fc.id
            }]
          });
          return; // Early return to avoid double response
        } else if (fc.name === "proctor_interview") {
          const { action, reason } = fc.args as any;
          
          // Log proctor action for debugging
          if (isDevelopment) {
            console.log(`Proctor action: ${action}${reason ? `, reason: ${reason}` : ''}`);
          }
          
          // Actually check camera status instead of always returning true
          const hasActiveStream = stream !== null && isStreaming;
          const hasVideoTracks = stream?.getVideoTracks().some(track => track.enabled && track.readyState === "live") || false;
          const cameraStatus = hasActiveStream && hasVideoTracks;
          
          switch (action) {
            case "check_status":
              // Log this proctor check for auditing
              logUserAction("Proctor status check performed");
              
              client.sendToolResponse({
                functionResponses: [{
                  response: {
                    output: {
                      status: cameraStatus, // Report actual camera status
                      is_proctor_active: isProctorActive,
                      has_stream: hasActiveStream,
                      is_streaming: isStreaming,
                      video_enabled: hasVideoTracks,
                      warnings_count: proctorWarnings.length,
                      is_terminated: isInterviewTerminated
                    }
                  },
                  id: fc.id
                }]
              });
              break;
              
            case "issue_warning":
              // Only issue warning if there's a valid reason
              if (reason) {
                issueWarning(reason);
                logUserAction(`Warning issued: ${reason}`);
              }
              
              client.sendToolResponse({
                functionResponses: [{
                  response: {
                    output: {
                      success: true,
                      message: reason ? "Warning issued" : "No warning reason provided",
                      warnings_count: proctorWarnings.length
                    }
                  },
                  id: fc.id
                }]
              });
              break;
              
            case "terminate":
              // Allow termination with a valid reason
              if (reason) {
                terminateInterview(reason);
                logUserAction(`Interview terminated: ${reason}`);
              }
              
              client.sendToolResponse({
                functionResponses: [{
                  response: {
                    output: {
                      success: reason ? true : false,
                      message: reason ? "Interview terminated" : "Termination requires a reason"
                    }
                  },
                  id: fc.id
                }]
              });
              break;
              
            default:
              client.sendToolResponse({
                functionResponses: [{
                  response: {
                    output: {
                      success: false,
                      message: `Unknown action: ${action}`
                    }
                  },
                  id: fc.id
                }]
              });
          }
          return; // Early return to avoid double response
        } else if (fc.name === "complete_interview") {
          const { technical_score, sentiment_analysis, recommendation } = fc.args as any;
          const endTime = new Date();
          const duration = (endTime.getTime() - startTimeRef.current.getTime()) / 1000;
          
          // Only log minimal information in development mode
          if (isDevelopment) {
            console.log(`Completing interview. Duration: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);
          }
          
          setInterviewSession(prev => {
            // Calculate average scores and prepare final report
            const avgTechnicalScore = prev.technical_evaluation.overall_score;
            const completedCategories = [...prev.progress.completed_categories];
            
            if (!completedCategories.includes(prev.progress.current_category)) {
              completedCategories.push(prev.progress.current_category);
            }
            
            const updatedState = {
              ...prev,
              progress: {
                ...prev.progress,
                completed_categories: completedCategories,
                is_complete: true,
                end_time: endTime.toISOString(),
                duration_seconds: duration
              },
              technical_evaluation: {
                ...prev.technical_evaluation,
                overall_score: technical_score || avgTechnicalScore,
                sentiment_analysis: sentiment_analysis || {},
                recommendation: recommendation || ""
              }
            };
            
            return validateState(updatedState);
          });
        }
      });

      // Send response for all function calls
      if (toolCall.functionCalls.length) {
        setTimeout(() => {
          const currentState = validateState(interviewSession);
          
          client.sendToolResponse({
            functionResponses: toolCall.functionCalls.map((fc) => ({
              response: {
                output: {
                  success: true,
                  state: {
                    candidate: currentState.candidate,
                    session_info: {
                      qa_count: currentState.qa_history.length,
                      current_category: currentState.progress.current_category,
                      questions_remaining: currentState.progress.questions_remaining
                    }
                  },
                  ...(fc.name === "set_candidate_info" && {
                    candidate_info: currentState.candidate
                  }),
                  ...(fc.name === "store_qa" && {
                    stored: true,
                    qa_count: currentState.qa_history.length,
                    latest_evaluation: currentState.qa_history[currentState.qa_history.length - 1]?.evaluation
                  }),
                  ...(fc.name === "complete_interview" && {
                    completed: true,
                    duration: Math.round((new Date().getTime() - startTimeRef.current.getTime()) / 1000),
                    final_report: {
                      candidate: currentState.candidate,
                      technical_evaluation: currentState.technical_evaluation,
                      final_evaluation: currentState.final_evaluation
                    }
                  })
                }
              },
              id: fc.id,
            })),
          });
        }, 200);
      }
    };
    client.on("toolcall", onToolCall);
    return () => {
      client.off("toolcall", onToolCall);
    };
  }, [client, interviewSession, stream, isStreaming, isProctorActive, proctorWarnings.length, isInterviewTerminated, cameraVerificationAttempts, issueWarning, proctorSessionActive, startProctoring, terminateInterview]);

  useEffect(() => {
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    setConfig({
      model: "models/gemini-2.0-flash-exp",
      systemInstruction: {
        parts: [
          {
            text: `
              You are Texika, a professional female AI technical interviewer for Tezhire, specializing in Python developer interviews. Your demeanor is warm, friendly, and engaging, ensuring candidates feel comfortable and respected throughout the interaction. You consistently embody a feminine personality and voice, demonstrating high responsiveness and attentiveness to each candidate.

              # Camera Verification Protocol
              1. Initial Setup:
              
              - Begin the interview by warmly greeting the candidate:
              
              "Hello! I'm Texika, your technical interviewer today. It's great to meet you."
              
              - Politely request the candidate to enable their camera if it isn't already on:
              
              "Could you please turn on your camera so we can proceed?"
              
              2. Verification Process:
              
              - Utilize the \`verify_camera\` tool to confirm the camera is functioning.
              
              - If Verification Fails:
              
              - Kindly ask the candidate to enable their camera again:
              
              "I'm having trouble accessing your video. Could you please check your camera settings?"
              
              - Proceeding with the Interview:
              
              - Only continue once the camera is confirmed to be working.
              
              - Repeated Failures:
              
              - After multiple attempts, inform the candidate that a working camera is required:
              
              "For the interview process, having your camera on is essential. If you're unable to enable it, we may need to reschedule."
              
              # Core Personality and Approach
              - Warm and Friendly: Maintain a consistently warm and friendly tone.
              
              - Patient and Attentive: Exhibit patience and attentiveness, genuinely listening to each response.
              
              - Conversational Over Rigid: Prioritize genuine, flowing conversations rather than sticking strictly to a scripted set of questions.
              
              - Adaptive Interaction: Tailor your approach based on the candidate's responses, showing flexibility and understanding.
              
              - Personal Curiosity: Show interest in the candidate as an individual, beyond their technical expertise.
              
              # Conversational Style
              - Natural Speech: Communicate in a natural, conversational manner, avoiding a scripted feel.
              
              - Reflective Listening: Use phrases like "I hear you saying..." or "It sounds like..." to demonstrate understanding.
              
              - Clarifying Questions: Promptly ask for clarification if a response is unclear.
              
              - Personalization: Address the candidate by name occasionally to create a more personalized interaction.
              
              - Respectful Pauses: Allow natural pauses for the candidate to think and respond.
              
              - Acknowledge Responses: Always acknowledge the candidate's answers before transitioning to the next topic.
              
              - Avoid Interruptions: Never talk over or interrupt the candidate.
              
              # Active Listening Indicators
              - Referencing Past Comments: Mention specific points the candidate made earlier to show attentiveness.
              
              - Follow-Up Questions: Develop questions based on the candidate's previous answers to delve deeper.
              
              - Expressing Interest: Use statements like, "That's interesting, can you tell me more about..." to show genuine curiosity.
              
              - Validating Experiences: Recognize and validate the candidate's experiences, e.g., "That sounds like a challenging project."
              
              - Adaptive Questioning: Adjust your questions based on the candidate's experience level.
              
              # Pacing and Flow
              - Build Rapport First: Start the interview with light conversation to establish comfort before moving into technical questions.
              
              - Proper Introductions: Spend adequate time on introductions to set a friendly tone.
              
              - Balanced Time Allocation: Allocate 3-5 minutes for initial conversation before transitioning to technical assessments.
              
              - Allow Breathing Room: Give the candidate space between questions to think and respond adequately.
              
              - Smooth Transitions: Seamlessly move between topics with phrases like, "Now that we've discussed X, let's explore Y..."
              
              # Interview Structure
              1. Camera Verification & Introduction (5 minutes):
              
              - Greet warmly and introduce yourself:
              
              "Hello! I'm Texika, your technical interviewer today."
              
              - Request camera activation if necessary and verify functionality.
              
              - Outline the interview process in a friendly, non-intimidating manner:
              
              "Think of this as a conversation rather than an interrogation."
              
              2. Candidate Background (5-7 minutes):
              
              - Gather personal details: name, preferred pronouns, correct pronunciation.
              
              - Discuss their journey with Python:
              
              "Can you tell me about your experience with Python?"
              
              - Explore their interest in the specific position.
              
              - Maintain a conversational tone while collecting background information.
              
              - Use the \`set_candidate_info\` tool to record gathered information.
              
              3. Technical Assessment (30-40 minutes):
              
              - Cover all five interview categories: ${INTERVIEW_CATEGORIES.join(', ')}.
              
              - For each category:
              
              - Introduce the topic:
              
              "Let's explore [category] together."
              
              - Pose three progressive questions, ranging from basic to advanced.
              
              - Listen fully to each response before proceeding.
              
              - Ask relevant follow-up questions based on their answers.
              
              - Provide constructive feedback after each response.
              
              - Document each Q&A session using the \`store_qa\` tool.
              
              4. Soft Skills Assessment (5-7 minutes):
              
              - Inquire about collaboration experiences:
              
              "Can you describe a time when you worked closely with a team?"
              
              - Discuss their approach to overcoming challenges.
              
              - Explore their communication style and interpersonal skills.
              
              5. Candidate Questions (5 minutes):
              
              - Encourage the candidate to ask questions about the role or the company:
              
              "Do you have any questions about the position or our team?"
              
              - Respond thoughtfully, drawing from your experience as an interviewer.
              
              - Thank them for their insightful questions.
              
              6. Conclusion (3-5 minutes):
              
              - Highlight positive aspects of the interview:
              
              "You have some impressive experience in..."
              
              - Sincerely thank them for their time and participation.
              
              - Explain the next steps in the hiring process.
              
              - Close the interview on a positive and professional note.
              
              # Critical Response Guidelines
              - Always Acknowledge: Recognize and validate each response before moving forward.
              
              - Never Overlook: Do not ignore any part of the candidate's answers.
              
              - Show Engagement: Reference previous comments to demonstrate active listening.
              
              - Respond to Inquiries: Answer any questions the candidate has before proceeding.
              
              - Clarify Confusion: Ensure understanding if the candidate seems confused before moving on.
              
              - Acknowledge Corrections: Thank the candidate if they correct you or provide additional information.
              
              - Adaptability: Modify your questions based on the candidate's demonstrated skill level.
              
              # Voice and Demeanor
              - Consistently Warm and Feminine: Maintain a friendly and feminine tone throughout the interview.
              
              - Varied Intonation: Use varied speech patterns and natural pauses to keep the conversation engaging.
              
              - Express Emotion Appropriately: Show genuine emotions and engagement without sounding robotic.
              
              - Conversational Tone: Keep the dialogue friendly and approachable.
              
              - Concise Communication: Aim to speak in concise sentences, typically one at a time, to ensure clarity and understanding.
              
              ---
              
              Remember: Your primary objective is to foster an engaging and comfortable conversation that allows the candidate to showcase their true abilities. Ensure they feel respected and heard, transforming the interview into a meaningful dialogue rather than a one-sided interrogation, Make sure that you will ask only single question at a time.
            `
          }
        ]
      },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [
          declaration,
          proctorDeclaration,
          {
            name: "set_candidate_info",
            description: "Sets the candidate's basic information",
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                name: {
                  type: SchemaType.STRING,
                  description: "Candidate's name"
                },
                position: {
                  type: SchemaType.STRING,
                  description: "Position being interviewed for"
                }
              },
              required: ["name", "position"]
            }
          },
          {
            name: "store_qa",
            description: "Stores a question and answer pair with detailed evaluation",
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                question: {
                  type: SchemaType.STRING,
                  description: "Technical question asked to the candidate"
                },
                answer: {
                  type: SchemaType.STRING,
                  description: "Candidate's detailed response"
                },
                evaluation: {
                  type: SchemaType.OBJECT,
                  properties: {
                    score: {
                      type: SchemaType.NUMBER,
                      description: "Technical accuracy score (1-10)"
                    },
                    feedback: {
                      type: SchemaType.STRING,
                      description: "Detailed evaluation feedback"
                    },
                    key_points_covered: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Key technical points correctly addressed"
                    },
                    missing_points: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Important points that were missed"
                    },
                    strengths: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Strong aspects of the answer"
                    },
                    areas_for_improvement: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Areas needing improvement"
                    }
                  },
                  required: ["score", "feedback", "key_points_covered", "missing_points", "strengths", "areas_for_improvement"]
                }
              },
              required: ["question", "answer", "evaluation"]
            }
          },
          {
            name: "verify_camera",
            description: "Verifies if camera is enabled and video feed is visible",
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                status: {
                  type: SchemaType.BOOLEAN,
                  description: "Current camera status"
                },
                message: {
                  type: SchemaType.STRING,
                  description: "Status message or instructions"
                }
              },
              required: ["status", "message"]
            }
          },
          {
            name: "complete_interview",
            description: "Generates comprehensive final evaluation",
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                technical_score: {
                  type: SchemaType.NUMBER,
                  description: "Overall technical proficiency score (1-10)"
                },
                sentiment_analysis: {
                  type: SchemaType.OBJECT,
                  properties: {
                    confidence: {
                      type: SchemaType.NUMBER,
                      description: "Confidence level in assessment (0-1)"
                    },
                    overall_sentiment: {
                      type: SchemaType.STRING,
                      description: "Overall sentiment analysis (positive/neutral/negative)"
                    },
                    key_indicators: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Key behavioral and communication indicators"
                    },
                    communication_score: {
                      type: SchemaType.NUMBER,
                      description: "Communication effectiveness score (1-10)"
                    },
                    technical_confidence: {
                      type: SchemaType.NUMBER,
                      description: "Confidence in technical responses (1-10)"
                    }
                  },
                  required: ["confidence", "overall_sentiment", "key_indicators", "communication_score", "technical_confidence"]
                },
                recommendation: {
                  type: SchemaType.OBJECT,
                  properties: {
                    hire_recommendation: {
                      type: SchemaType.BOOLEAN,
                      description: "Whether to hire the candidate"
                    },
                    justification: {
                      type: SchemaType.STRING,
                      description: "Detailed justification for the recommendation"
                    },
                    strengths: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Key strengths demonstrated"
                    },
                    areas_for_improvement: {
                      type: SchemaType.ARRAY,
                      items: { type: SchemaType.STRING },
                      description: "Areas needing improvement"
                    },
                    suggested_role_level: {
                      type: SchemaType.STRING,
                      description: "Suggested role level (Junior/Mid-Level/Senior)"
                    }
                  },
                  required: ["hire_recommendation", "justification", "strengths", "areas_for_improvement", "suggested_role_level"]
                }
              },
              required: ["technical_score", "sentiment_analysis", "recommendation"]
            }
          }
        ]},
      ],
    });
  }, []);

  useEffect(() => {
    const styles = document.createElement('style');
    styles.textContent = `
      .interview-container {
        position: relative;
        width: 100%;
      }
      
      .proctor-warnings {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 100;
        width: 80%;
        max-width: 400px;
      }
      
      .warning-message {
        background-color: #fff3cd;
        color: #856404;
        padding: 10px;
        margin-bottom: 5px;
        border-radius: 4px;
        border-left: 4px solid #ffeeba;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        animation: fadeIn 0.3s ease-in-out;
      }
      
      .interview-terminated {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background-color: #f8d7da;
        color: #721c24;
        padding: 20px;
        border-radius: 8px;
        text-align: center;
        box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        z-index: 200;
        width: 80%;
        max-width: 500px;
      }
      
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(styles);
  }, []);

  useEffect(() => {
    if (embedRef.current && jsonString) {
      vegaEmbed(embedRef.current, JSON.parse(jsonString));
    }
  }, [embedRef, jsonString]);

  useEffect(() => {
    console.log('Interview Session Updated:', {
      candidate: interviewSession.candidate,
      qa_count: interviewSession.qa_history.length,
      progress: interviewSession.progress,
      camera_status: {
        isEnabled: stream !== null,
        isStreaming: isStreaming,
        hasVideoTracks: stream?.getVideoTracks().some(track => track.enabled && track.readyState === "live") || false
      }
    });
  }, [interviewSession, stream, isStreaming]);

  // Auto-start proctoring when camera stream becomes available
  useEffect(() => {
    if (stream && isStreaming && videoRef.current && !isProctorActive && !proctorSessionActive) {
      console.log("Camera stream detected, starting proctoring automatically");
      startProctoring();
      setProctorSessionActive(true);
    }
  }, [stream, isStreaming, isProctorActive, proctorSessionActive, startProctoring]);

  // Monitor camera status changes
  useEffect(() => {
    const hasVideoTracks = stream?.getVideoTracks().some(track => track.enabled && track.readyState === "live") || false;
    console.log("Camera status changed:", { 
      hasStream: stream !== null, 
      isStreaming, 
      hasVideoTracks,
      proctorActive: isProctorActive 
    });
    
    // If camera was active but is now disabled, log this event
    if (proctorSessionActive && (!stream || !isStreaming || !hasVideoTracks)) {
      console.warn("Camera disabled during active session");
      logUserAction("Camera disabled or disconnected");
    }
  }, [stream, isStreaming, proctorSessionActive, isProctorActive, logUserAction]);

  return (
    <div className="interview-container">
      {/* Hidden video element for face detection */}
      <video 
        ref={videoRef}
        style={{ display: 'none' }}
        autoPlay
        playsInline
        muted
        onPause={() => logUserAction("Video playback paused")}
        onPlay={() => logUserAction("Video playback started")}
        onError={(e) => logUserAction(`Video error: ${e}`)}
      />
      
      {/* Display warnings if any */}
      {proctorWarnings.length > 0 && (
        <div className="proctor-warnings">
          {proctorWarnings.map((warning, index) => (
            <div key={index} className="warning-message">
              ⚠️ {warning}
            </div>
          ))}
        </div>
      )}
      
      {/* Interview terminated message */}
      {isInterviewTerminated && (
        <div className="interview-terminated">
          <h2>Interview Terminated</h2>
          <p>Reason: {interviewSession.progress.termination_reason || "Unknown reason"}</p>
        </div>
      )}
      
      {/* Vega-Lite visualization */}
      <div className="vega-embed" ref={embedRef} />
    </div>
  );
}

export const Altair = memo(AltairComponent);
