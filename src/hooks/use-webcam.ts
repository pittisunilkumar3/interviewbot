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

import { useState, useEffect } from "react";
import { UseMediaStreamResult } from "./use-media-stream-mux";

export function useWebcam(): UseMediaStreamResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    const handleStreamEnded = () => {
      setIsStreaming(false);
      setStream(null);
    };
    if (stream) {
      stream
        .getTracks()
        .forEach((track) => track.addEventListener("ended", handleStreamEnded));
      return () => {
        stream
          .getTracks()
          .forEach((track) =>
            track.removeEventListener("ended", handleStreamEnded),
          );
      };
    }
  }, [stream]);

  const start = async () => {
    // Check if we already have an active stream to avoid requesting permission again
    if (stream && stream.active && stream.getVideoTracks().some(track => track.enabled)) {
      console.log("Using existing camera stream");
      return stream;
    }

    try {
      console.log("Requesting camera access...");
      const mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
      
      // Store the stream in state
      setStream(mediaStream);
      setIsStreaming(true);
      
      // Add event listeners to track when user manually stops the camera
      mediaStream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', () => {
          console.log("Camera track ended by user or system");
          setIsStreaming(false);
        });
      });
      
      return mediaStream;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        console.error("Camera access denied. Please enable camera permissions.");
      } else {
        console.error("Unexpected error accessing camera:", error);
      }
      setIsStreaming(false);
      throw error;
    }
  };

  const stop = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
      setIsStreaming(false);
    }
  };

  const result: UseMediaStreamResult = {
    type: "webcam",
    start,
    stop,
    isStreaming,
    stream,
  };

  return result;
}
