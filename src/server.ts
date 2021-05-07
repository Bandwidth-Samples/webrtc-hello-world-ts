import path from "path";
import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
const bandwidthWebRTC = require("@bandwidth/webrtc");

dotenv.config();

const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 5000;
const accountId = <string>process.env.BW_ACCOUNT_ID;
const username = <string>process.env.BW_USERNAME;
const password = <string>process.env.BW_PASSWORD;
const voiceApplicationPhoneNumber = <string>process.env.BW_NUMBER;
const voiceApplicationId = <string>process.env.BW_VOICE_APPLICATION_ID;
const voiceCallbackUrl = <string>process.env.BASE_CALLBACK_URL;
const outboundPhoneNumber = <string>process.env.USER_NUMBER;

const callControlUrl = `${process.env.BANDWIDTH_WEBRTC_CALL_CONTROL_URL}/accounts/${accountId}`;

// Check to make sure required environment variables are set
if (!accountId || !username || !password) {
  console.error(
    "ERROR! Please set the BW_ACCOUNT_ID, BW_USERNAME, and BW_PASSWORD environment variables before running this app"
  );
  process.exit(1);
}

interface Participant {
  id: string;
  token: string;
}

let webRTCController = bandwidthWebRTC.APIController;
let sessionId: string;
let calls: Map<string, Participant> = new Map(); // Call IDs to Participants

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
  const { id, token } = await createParticipant("hello-world-browser");
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
  const participant = await createParticipant("hello-world-phone");
  await callPhone(outboundPhoneNumber, participant);
  res.status(204).send();
});

/**
 * Bandwidth's Voice API will hit this endpoint when we receive an incoming call
 */
app.post("/incomingCall", async (req, res) => {
  const callId = req.body.callId;
  console.log(`received incoming call ${callId} from ${req.body.from}`);
  const participant = await createParticipant("hello-world-phone");
  calls.set(callId, participant);

  // This is the response payload that we will send back to the Voice API to transfer the call into the WebRTC session
  const bxml = webRTCController.generateTransferBxml(participant.token);

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
      ${webRTCController.generateTransferBxmlVerb(participant.token)}
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
      await axios.get(`${callControlUrl}/sessions/${sessionId}`, {
        auth: {
          username: username,
          password: password,
        },
      });
      console.log(`using session ${sessionId}`);
      return sessionId;
    } catch (e) {
      console.log(`session ${sessionId} is invalid, creating a new session`);
    }
  }

  // Otherwise start a new one and return the ID
  let response = await axios.post(
    `${callControlUrl}/sessions`,
    {
      tag: "hello-world",
    },
    {
      auth: {
        username: username,
        password: password,
      },
    }
  );
  sessionId = response.data.id;
  console.log(`created new session ${sessionId}`);
  return sessionId;
};

/**
 * Create a new participant and save their ID to our app's state map
 */
const createParticipant = async (tag: string): Promise<Participant> => {
  // Create a new participant
  let createParticipantResponse = await axios.post(
    `${callControlUrl}/participants`,
    {
      publishPermissions: ["AUDIO"],
      tag: tag,
      deviceApiVersion: "V3"
    },
    {
      auth: {
        username: username,
        password: password,
      },
    }
  );

  const participant = createParticipantResponse.data.participant;
  const token = createParticipantResponse.data.token;
  const participantId = participant.id;
  console.log(`created new participant ${participantId}`);

  // Add participant to session
  const sessionId = await getSessionId();
  await axios.put(
    `${callControlUrl}/sessions/${sessionId}/participants/${participant.id}`,
    {
      sessionId: sessionId,
    },
    {
      auth: {
        username: username,
        password: password,
      },
    }
  );

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
  await axios.delete(
    `${callControlUrl}/participants/${participantId}`,
    {
      auth: {
        username: username,
        password: password,
      },
    }
  );
}

/**
 * Ask Bandwidth's Voice API to call the outbound phone number, with an answer callback url that
 * includes the participant ID
 */
const callPhone = async (phoneNumber: string, participant: Participant) => {
  try {
    let response = await axios.post(
      `https://voice.bandwidth.com/api/v2/accounts/${accountId}/calls`,
      {
        from: voiceApplicationPhoneNumber,
        to: phoneNumber,
        answerUrl: `${voiceCallbackUrl}/callAnswered`,
        disconnectUrl: `${voiceCallbackUrl}/callStatus`,
        applicationId: voiceApplicationId,
      },
      {
        auth: {
          username: username,
          password: password,
        },
      }
    );
    const callId = response.data.callId;
    calls.set(callId, participant);
    console.log(`initiated call ${callId} to ${outboundPhoneNumber}...`);
  } catch (e) {
    console.log(`error calling ${outboundPhoneNumber}: ${e}`);
  }
};

