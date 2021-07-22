import path from "path";
import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import {
  Client as WebRtcClient,
  Session,
  Participant,
  PublishPermissionEnum,
  Subscriptions,
  ApiController as WebRtcController,
  DeviceApiVersionEnum
} from "@bandwidth/webrtc";

import {
  Client as VoiceClient,
  ApiController as VoiceController,
    ApiCreateCallRequest
} from "@bandwidth/voice";

dotenv.config();

const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 5000;
const accountId = <string>process.env.BW_ACCOUNT_ID;
const username = <string>process.env.BW_USERNAME;
const password = <string>process.env.BW_PASSWORD;
const voiceApplicationPhoneNumber = <string>process.env.BW_NUMBER;
const voiceApplicationId = <string>process.env.BW_VOICE_APPLICATION_ID;
const baseCallbackUrl = <string>process.env.BASE_CALLBACK_URL;
const outboundPhoneNumber = <string>process.env.USER_NUMBER;

// Check to make sure required environment variables are set
if (!accountId || !username || !password) {
  console.error(
    "ERROR! Please set the BW_ACCOUNT_ID, BW_USERNAME, and BW_PASSWORD environment variables before running this app"
  );
  process.exit(1);
}

interface ParticipantInfo {
  id: string;
  token: string;
}

const webRTCClient = new WebRtcClient({
  basicAuthUserName: username,
  basicAuthPassword: password
})
const webRTCController = new WebRtcController(webRTCClient);

const voiceClient = new VoiceClient({
  basicAuthUserName: username,
  basicAuthPassword: password
})
const voiceController = new VoiceController(voiceClient);

let sessionId: string;
let calls: Map<string, ParticipantInfo> = new Map(); // Call IDs to ParticipantInfos

/////////////////////////////////////////////////////////////////////////////
//                                                                         //
// REST API Config                                                         //
//                                                                         //
// These endpoints handle requests from the browser to get connection      //
// info and requests from the Voice API to handle incoming phone calls     //
//                                                                         //
/////////////////////////////////////////////////////////////////////////////

/**
 * The browser will hit this endpoint to get a session and participant ID
 */
app.get("/connectionInfo", async (req, res) => {
  const { id, token } = await createParticipant("hello-world-ts-browser");
  res.send({
    token: token,
    voiceApplicationPhoneNumber: voiceApplicationPhoneNumber,
    outboundPhoneNumber: outboundPhoneNumber,
  });
});

/**
 * The browser will hit this endpoint to initiate a call to the outbound phone number
 */
app.get("/callPhone", async (req, res) => {
  if (!outboundPhoneNumber) {
    console.log("no outbound phone number has been set");
    res.status(400).send();
  }
  const participant = await createParticipant("hello-world-ts-phone");
  await callPhone(outboundPhoneNumber, participant);
  res.status(204).send();
});

/**
 * Bandwidth's Voice API will hit this endpoint when we receive an incoming call
 */
app.post("/incomingCall", async (req, res) => {
  const callId = req.body.callId;
  console.log(`received incoming call ${callId} from ${req.body.from}`);
  const participant = await createParticipant("hello-world-ts-phone");
  calls.set(callId, participant);

  // This is the response payload that we will send back to the Voice API to transfer the call into the WebRTC session
  const bxml = WebRtcController.generateTransferBxml(participant.token, callId);

  // Send the payload back to the Voice API
  res.contentType("application/xml").send(bxml);
  console.log(`transferring call ${callId} to session ${sessionId} as participant ${participant.id}`);
});

/**
 * Bandwidth's Voice API will hit this endpoint when an outgoing call is answered
 */
app.post("/callAnswered", async (req, res) => {
  const callId = req.body.callId;
  console.log(`received answered callback for call ${callId} tp ${req.body.to}`);
  
  const participant = calls.get(callId);
  if (!participant) {
    console.log(`no participant found for ${callId}!`);
    res.status(400).send();
    return;
  }

  // This is the response payload that we will send back to the Voice API to transfer the call into the WebRTC session
  const bxml = `<?xml version="1.0" encoding="UTF-8" ?>
  <Response>
      <SpeakSentence voice="julie">Thank you. Connecting you to your conference now.</SpeakSentence>
      ${WebRtcController.generateTransferBxmlVerb(participant.token, callId)}
  </Response>`;

  // Send the payload back to the Voice API
  res.contentType("application/xml").send(bxml);
  console.log(`transferring call ${callId} to session ${sessionId} as participant ${participant.id}`);
});

/**
 * Bandwidth's Voice API will hit this endpoint with status updates for calls
 */
app.post("/callStatus", async (req, res) => {
  res.status(200).send();
  if (req.body.eventType === "disconnect") {
    // Do some cleanup
    const callId = req.body.callId;
    console.log(`received disconnect event for call ${callId}`);
    const participant = calls.get(callId);
    if (participant) {
      deleteParticipant(participant.id);
      calls.delete(callId);
    } else {
      console.log("no participant associated with event", req.body);
    }
  } else {
    console.log("received unexpected status update", req.body);
  }
});

// These two lines set up static file serving for the React frontend
app.use(express.static(path.join(__dirname, "..", "frontend", "build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "build", "index.html"));
});
app.listen(port, () => console.log(`WebRTC Hello World listening on port ${port}!`));

/////////////////////////////////////////////////////////////////////////////
//                                                                         //
// Bandwidth WebRTC Functions                                              //
//                                                                         //
// The following few functions make requests to the WebRTC Service to      //
// create sessions and participants.                                       //
//                                                                         //
/////////////////////////////////////////////////////////////////////////////

/**
 * Get a new or existing WebRTC session ID
 */
const getSessionId = async (): Promise<string> => {
  // If we already have a valid session going, just re-use that one
  if (sessionId) {
    try {
      let getSessionResponse = await webRTCController.getSession(accountId, sessionId);
      const existingSession: Session = getSessionResponse.result;
      console.log(`using session ${existingSession.id}`);
      if (!existingSession.id) {
        throw Error('No session ID in result');
      }
      return existingSession.id;
    } catch (e) {
      console.log(`session ${sessionId} is invalid, creating a new session`);
    }
  }

  // Otherwise start a new one and return the ID
  const createSessionBody : Session = {
    tag: "hello-world"
  }
  let response = await webRTCController.createSession(accountId, createSessionBody);
  if (!response.result.id) {
    throw Error('No Session ID in Create Session Response');
  }
  sessionId = response.result.id;
  console.log(`created new session ${sessionId}`);
  return sessionId;
};

/**
 * Create a new participant and save their ID to our app's state map
 */
const createParticipant = async (tag: string): Promise<ParticipantInfo> => {
  // Create a new participant
  const participantBody : Participant = {
    tag: tag,
    publishPermissions: [PublishPermissionEnum.AUDIO],
    deviceApiVersion: DeviceApiVersionEnum.V3
  };

  let createParticipantResponse = await webRTCController.createParticipant(accountId, participantBody);
  const participant = createParticipantResponse.result.participant;

  if (!createParticipantResponse.result.token) {
    throw Error('No token in Create Participant Response');
  }
  const token = createParticipantResponse.result.token;

  if (!participant?.id) {
    throw Error('No participant ID in Create Participant Response');
  }
  const participantId = participant?.id;

  console.log(`Created new participant ${participantId}`);

  // Add participant to session
  const sessionId = await getSessionId();
  const subscriptions : Subscriptions = {
    sessionId: sessionId
  }

  await webRTCController.addParticipantToSession(accountId, sessionId, participantId, subscriptions);

  return {
    id: participantId,
    token: token,
  };
};

/**
 * Delete a participant
 */
const deleteParticipant = async (participantId: string) => {
  console.log(`deleting participant ${participantId}`);
  await webRTCController.deleteParticipant(accountId, participantId);
}

/**
 * Ask Bandwidth's Voice API to call the outbound phone number, with an answer callback url that
 * includes the participant ID
 */
const callPhone = async (phoneNumber: string, participant: ParticipantInfo) => {
  const createCallRequest: ApiCreateCallRequest = {
    from: voiceApplicationPhoneNumber,
    to: phoneNumber,
    answerUrl: `${baseCallbackUrl}/callAnswered`,
    disconnectUrl: `${baseCallbackUrl}/callStatus`,
    applicationId: voiceApplicationId,
  }

  try {
    let response = await voiceController.createCall(accountId, createCallRequest);
    const callId = response.result.callId;
    calls.set(callId, participant);
    console.log(`initiated call ${callId} to ${outboundPhoneNumber}...`);
  } catch (e) {
    console.log(`error calling ${outboundPhoneNumber}: ${e}`);
  }
};

