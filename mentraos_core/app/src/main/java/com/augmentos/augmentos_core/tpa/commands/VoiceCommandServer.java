////NOTES:
////there is a race condition in how the sockets are setup
////if we restartSocket() then SendThread or ReceiveThread fails, it will set the mConnectState back to 0 even though we are currently trying to connect
////need to have some handler that only send mConnectState = 0 if it's currently = 2. If it's =1, then don't change it
//
//
//// Copyright 2019 The MediaPipe Authors.
////
//// Licensed under the Apache License, Version 2.0 (the "License");
//// you may not use this file except in compliance with the License.
//// You may obtain a copy of the License at
////
////      http://www.apache.org/licenses/LICENSE-2.0
////
//// Unless required by applicable law or agreed to in writing, software
//// distributed under the License is distributed on an "AS IS" BASIS,
//// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//// See the License for the specific language governing permissions and
//// limitations under the License.
//
//package com.augmentos.augmentos_core.tpa.commands;
//
//import android.content.Context;
//import android.os.Handler;
//import android.os.HandlerThread;
//import android.util.Log;
//import android.util.Pair;
//
//
//import com.augmentos.augmentoslib.AugmentOSCommand;
//import com.augmentos.augmentoslib.events.CommandTriggeredEvent;
//import com.augmentos.augmentoslib.events.ReferenceCardSimpleViewRequestEvent;
//
//import com.augmentos.augmentoslib.events.SpeechRecFinalOutputEvent;
//import com.augmentos.augmentoslib.events.SpeechRecIntermediateOutputEvent;
//
//import org.greenrobot.eventbus.EventBus;
//import org.greenrobot.eventbus.Subscribe;
//
//import java.util.ArrayList;
//import java.util.Arrays;
//
////parse, interpret, run commands
////low pass filter on speech to text so user can say voice command slowly
////send updates when wake words, commands, arguments are seen to ASG, so user knows that what they are trying to say has been recognized, and they can see suggestions for next commands, arguments, etc.
///*
//HOW THIS WORKS:
//
//The voice command server is a state machine.
//
//1. Maintain a buffer of transcripts, which might span multiple ASR transcript "blocks", and run a voice command parser pass on that buffer whenever new text comes in, or whenever a certain length pause (after previous speaking) has been detected.
//2. Parse and look for wake words. If no wake word is found/has been found, don't do anything.
//2.
// */
//public class VoiceCommandServer {
//    private  final String TAG = "WearableAi_VoiceCommand";
//
//    //handlers
//    private Handler vcHandler;
//    private HandlerThread mHandlerThread;
//
//    //nlp
//    private NlpUtils nlpUtils;
//
//    //voice command stuff
//    private ArrayList<AugmentOSCommand> voiceCommands;
//    private ArrayList<String> wakeWords;
//    private ArrayList<String> endWords;
//
//    //timing of voice command system
//    private long voiceCommandPauseTime = 6000; //milliseconds //amount of time user must pause speaking before we consider the command to be finished
//    private long lastParseTime = 0; //milliseconds since last time we parse a command (executing or not)
//    private long lastTranscriptTime = 0; //milliseconds since we last received a transcript
//    private int partialTranscriptBufferIdx = 0; //this is set true when an end word is found, so we don't keep trying to process incoming INTERMEDIATE_TRANSCRIPTs if we have already processing the current buffer - we need to wait for the next transcript
//    private boolean newTranscriptSinceRun = false; //has a new transcript come in since we last parsed a voice command?
//    private boolean currentlyParsing = false; //are we currently parsing? if so, don't try to parse again at the same time
//
//    //the current voice buffer that we are processing, with metadata about the latest phrase/transcript which makes up that voice buffer
//    private String lowPassTranscriptString = "";//we whold our own transcript, instead of using the raw ones from ASR, because ASR splits up final transcripts at a short (~1 second) pause, but we want to be able to run commands with larger pauses, and so we need our own "low passed" transcript buffer that keeps getting appended with new transcripts
//    long lowPassTranscriptTime = 0l;
//
//    boolean startNewVoiceCliBuffer = true;
//    boolean useNextTranscriptMetaData = true;
//
//    //voice command fuzzy search threshold
//    private final double wakeWordThreshold = 0.88;
//    private final double commandThreshold = 0.88;
//    private final double endWordThreshold = 0.92;
//
//    //flags to save the current state and info about the currently streaming in voice command
//    boolean waked = false;
//    String wakeWordGiven = "";
//    int wakeWordEndIdx = -1;
//    boolean commanded = false;
//    AugmentOSCommand commandGiven;
//    long commandGivenTime;
//    int commandEndIdx = -1;
//    boolean gotArg = false;
//    boolean askedForNaturalLanguage = false;
//    boolean haveRequestedArg = false;
//    boolean ended = false;
//
//    public VoiceCommandServer(Context context){
//        voiceCommands = new ArrayList<>();
//
//        //setup nlp
//        nlpUtils = NlpUtils.getInstance(context);
//
//        //setup handler for voice commands
//        mHandlerThread = new HandlerThread("VoiceCommandHandler");
//        mHandlerThread.start();
//        vcHandler = new Handler(mHandlerThread.getLooper());
//
//        //setup wake and end words
//        wakeWords = new ArrayList<>(Arrays.asList(new String [] {"hey computer", "a computer", "aurora", "harken", "vivify"}));
//        endWords = new ArrayList<>(Arrays.asList(new String [] {"finish command"}));
//
//        //keeps checking to see if there is a command to be run
//        startSittingCommandHitter();
//
//        //subscribe to events
//        EventBus.getDefault().register(this);
//    }
//
//    public void updateVoiceCommands(ArrayList<AugmentOSCommand> inputVoiceCommands){
//        this.voiceCommands = inputVoiceCommands;
//    }
//
//    private void startSittingCommandHitter(){
//        //every n milliseconds, check if there is a command that has been input via voice command (voice CLI) that is ready to be run
//        lastTranscriptTime = System.currentTimeMillis();
//        vcHandler.postDelayed(new Runnable() {
//            @Override
//            public void run() {
//                long currTime = System.currentTimeMillis();
//
//                if (newTranscriptSinceRun && (((currTime - lastParseTime) > voiceCommandPauseTime)) && ((currTime - lastTranscriptTime) > voiceCommandPauseTime)){
//                    parseVoiceCommandBuffer(lowPassTranscriptString, true);
//                    restartTranscriptBuffer(0, true);
//                    if (waked){ //if we had already woken up, but no command has run, let ASG know to go exit the command
//                        cancelVoiceCommand();
//                        resetVoiceCommand();
//                    }
//                }
//
//                long waitTime;
//                if (!newTranscriptSinceRun) {
//                    waitTime = voiceCommandPauseTime + 10;
//                } else {
//                    waitTime = ((voiceCommandPauseTime + lastTranscriptTime) - currTime) + 10; //plus 10 milliseconds for potential OS jitter (I don't know if it's actually needed)
//                }
//
//                vcHandler.postDelayed(this, waitTime);
//            }
//        }, voiceCommandPauseTime + 10);
//
//    }
//
//    // handles timing of transcripts and keeping a proper buffer that is delineated by voice commands
//    // allows users to have plenty of time to speak to enter commands
//    private void handleNewTranscript(String transcript, long timestamp, boolean isFinal){ long currTime = System.currentTimeMillis();
//        //set last transcript heard time
//        lastTranscriptTime = currTime;
//
//        transcript = transcript.toLowerCase();
//        //if the current partial transcript idx is greater than the current transcript, ignore this transcript. This can happen if ASR predicts a word, then pulls it back or changes it to a shorter word. For now, we just don't consider it until the length it greater than before
//        if ((partialTranscriptBufferIdx + 1) > transcript.length()){
//            //if it's the final one, reset our idx to 0, because we no longer have a buffer
//            if (isFinal) {
//                partialTranscriptBufferIdx = 0;
//            }
//            lowPassTranscriptString = "";
//            return;
//        }
//
//        //if there is new transcript to consider AND we have been instructed to start a new voice cli buffer, start a new voice cli buffer, starting from the given partialidx
//        if (startNewVoiceCliBuffer){
//            lowPassTranscriptString = "";
//            startNewVoiceCliBuffer = false;
//        }
//
//        newTranscriptSinceRun = true;
//
//        //get current passed in transcript starting from the start point
//        String partialTranscript = transcript.substring(partialTranscriptBufferIdx);
//
//        //the transcript to parse is the voice buffer plus the latest added in partial transcript
//        String transcriptToParse = lowPassTranscriptString + " " + partialTranscript;
//
//        //should we update the buffer's timestamp and ID at the next transcript?
//        if (useNextTranscriptMetaData){
//            lowPassTranscriptTime = timestamp;
//            useNextTranscriptMetaData = false;
//        }
//
//        if (isFinal) {
//            lowPassTranscriptString = transcriptToParse;
//
//            //if we are grabbing a partial transcript, but now we've received the final transcript, we can stop parsing the current transcript as a partial transcript on the next incoming transcript
//            partialTranscriptBufferIdx = 0;
//        }
//
//        //parse transcript - but don't run too often
//        if ((System.currentTimeMillis() - lastParseTime) > 400) {
//            parseVoiceCommandBuffer(transcriptToParse, false);
//        }
//    }
//
//    private void restartTranscriptBuffer(int partialIdx, Boolean useNext){
//        partialTranscriptBufferIdx = partialIdx;
//        startNewVoiceCliBuffer = true;
//        if (useNext != null) {
//            useNextTranscriptMetaData = useNext;
//        }
//   }
//
//    //run a parsing pass on the current voice transcript buffer. This depends on the current state of the machine w.r.t. what we have already found - wake word, command, arguments, end word, etc.
//    private void parseVoiceCommandBuffer(String transcript, boolean run) {
//        //return if we are currently parsing another string
//        if (currentlyParsing) {
//            return;
//        }
//        currentlyParsing = true;
//
//        long currTime = System.currentTimeMillis();
//        lastParseTime = currTime;
//
//        //loop through all voice commands to see if any of their wake words match
//        if (!waked) { //only run this if we haven't already detected a wake word
//            //loop through all global wake words to see if any match
//            for (int i = 0; i < wakeWords.size(); i++){
//                String currWakeWord = wakeWords.get(i);
//                FuzzyMatch wakeWordLocation = nlpUtils.findNearMatches(transcript, currWakeWord, wakeWordThreshold); //transcript.indexOf(currWakeWord);
//                if (wakeWordLocation != null && wakeWordLocation.getIndex() != -1){ //if the substring "wake word" is in the larger string "transcript"
//                    //we found a command, now get its arguments and run it
//                    foundWakeWord(currWakeWord, wakeWordLocation.getIndex() + currWakeWord.length());
//                    break;
//                }
//            }
//        }
//
//        //search for command input
//        String preArgs;
//        String rest;
//        if (waked) { //only search for a command if we've already woken
//            preArgs = transcript.substring(0, wakeWordEndIdx - wakeWordGiven.length()); //get args before the wakeword
//            try {
//                rest = transcript.substring(wakeWordEndIdx);
//            } catch (StringIndexOutOfBoundsException e){
//                rest = "";
//            }
//
//            //FIND COMMAND
//            if (!commanded) {
//                //search for a command. If it's found, we'll save it
//                parseCommand(preArgs, wakeWordGiven, rest, currTime, run);
//            }
//
//            //FIND END WORD
//            //if we find an "end command" voice command, execute now
//            //loop through all global endwords to see if any match
//            int partialIdx = partialTranscriptBufferIdx;
//            int endWordLocationIdx = -1;
//            for (int i = 0; i < endWords.size(); i++) {
//                String currEndWord = endWords.get(i);
//                FuzzyMatch endWordLocation = nlpUtils.findNearMatches(transcript, currEndWord, endWordThreshold); //transcript.indexOf(currEndWord);
//                if (endWordLocation != null && endWordLocation.getIndex() != -1) { //if the substring "end word" is in the larger string "transcript"
//                    //we detected an end word, so act on it if we've been commanded, or cancel if not
//                    Log.d(TAG, "Detected end word");
//                    partialIdx = partialTranscriptBufferIdx + endWordLocation.getIndex() + currEndWord.length();
//                    if (!commanded) {
//                        Log.d(TAG, "Wake word detected with no command input: " + rest);
//                        cancelVoiceCommand();
//                        run = true;
//                        restartTranscriptBuffer(partialIdx, null);
//                        ended = true;
//                        endWordLocationIdx = endWordLocation.getIndex();
//                        break;
//                    }
//                    String transcriptSansEndWord = transcript.substring(0, endWordLocation.getIndex());
//                    rest = transcriptSansEndWord;
//                    run = true;
//                    ended = true;
//                    endWordLocationIdx = endWordLocation.getIndex();
//                }
//            }
//
//            //if we've receive a command, either run it, or get arguments from the user
//            if (commanded) { //if we've already found a command, just check if we are still waiting on a required argument
//                //if we've been commanded, then get the string after the command, which makes up the arguments
//                String postArgs = "";
//                try {
//                    if (ended) {
//                        postArgs = transcript.substring(commandEndIdx, endWordLocationIdx);
//                    } else {
//                        postArgs = transcript.substring(commandEndIdx);
//                    }
//                } catch (StringIndexOutOfBoundsException e) {
//                    postArgs = "";
//                }
//
//                int firstSpace = postArgs.indexOf(" ");
//                if (firstSpace != -1) { //if there is no space, then there is no new word after the command word, and thus nothing to show
//                    postArgs = postArgs.substring(firstSpace + 1);//string after the commands ends and after the next space
//                }
//
//                //if we found an n word, or if we've been instructed to run regardless, then run the command
//                if (ended){
//                    //find the command and run it
//                    restartTranscriptBuffer(partialIdx, null);
//                    runCommand(commandGiven, preArgs, wakeWordGiven, postArgs, commandGivenTime);
//                } else { //if we haven't ended yet but have a command, either run it or get args
//                    if (!commandGiven.argRequired || (gotArg)) {
//                        restartTranscriptBuffer(commandEndIdx, true);
//                        runCommand(commandGiven, preArgs, wakeWordGiven, "", commandGivenTime);
//                    } else if ((commandGiven.argRequired & commandGiven.argOptions != null) & !haveRequestedArg) { //if we want an arg and there are arg options, prompt for the required arg
//                        needRequiredArg(commandGiven.argPrompt, commandGiven.argOptions);
//                    } else if ((commandGiven.argRequired & commandGiven.argOptions == null) & !haveRequestedArg) { //if we want an arg and there are NOT arg options, get natural langauge arg
//                        needNaturalLanguageArgs(transcript, commandGiven.getName(), commandGiven.argPrompt);
//                    }
//                }
//            } else {
//                //if we have been woken, but received no command, and now running, just cancel
//                if (run & !ended) {
//                    cancelVoiceCommand();
//                    restartTranscriptBuffer(partialTranscriptBufferIdx, null);
//                }
//            }
//        }
//
//        if (run){
//            newTranscriptSinceRun = false;
//        }
//
//        currentlyParsing = false;
//    }
//
//    private void parseCommand(String preArgs, String wakeWord, String rest, long commandTime, boolean run){
//        FuzzyMatch bestMatch = new FuzzyMatch(-1,0);
//        int bestMatchIdx = -1;
//        int vcIdx = -1;
//        for (int i = 0; i < voiceCommands.size(); i++) {
//            Pair<FuzzyMatch, Integer> commandBestMatch = nlpUtils.findBestMatch(rest, voiceCommands.get(i).getPhrases(), commandThreshold);
//            if (commandBestMatch != null) {
//                FuzzyMatch commandMatch = commandBestMatch.first;
//                int commandMatchIdx = commandBestMatch.second;
//                if (commandMatch.getSimilarity() > bestMatch.getSimilarity()) {
//                    bestMatch = commandMatch;
//                    bestMatchIdx = commandMatchIdx;
//                    vcIdx = i;
//                }
//            }
//        }
//        if (bestMatch.getIndex() != -1){
//            FuzzyMatch commandMatch = bestMatch;
//            int commandMatchIdx = bestMatchIdx;
//            String commandMatchString = voiceCommands.get(vcIdx).getPhrases().get(commandMatchIdx);
//
//            Log.d(TAG, "FOUND MATCH: " + commandMatchString);
//
//            foundCommand(voiceCommands.get(vcIdx), partialTranscriptBufferIdx + wakeWordEndIdx + commandMatch.getIndex() + commandMatchString.length(), commandTime);
//
//            currentlyParsing = false;
//            return;
//        }
//    }
//
//    private void needRequiredArg(String prompt, ArrayList<String> possibleArgs){
//        haveRequestedArg = true;
//        Log.d(TAG, "needRequiredArg called");
//        //tell user that we have found a command but now need a required argument
//        String [] possibleArgsSA = possibleArgs.toArray(new String[0]);
//        EventBus.getDefault().post(new PromptViewRequestEvent(prompt, possibleArgsSA));
//    }
//
//    private void needNaturalLanguageArgs(String transcript, String command, String prompt){
//        //get the bit of our transcript that we need to show
//        String subSubString = "";
//        if (transcript.length() > commandEndIdx) {
//            String subString = transcript.substring(commandEndIdx); //string after the command ends
//            int firstSubStringSpace = subString.indexOf(" ");
//            if (firstSubStringSpace != -1) { //if there is no space, then there is no new word after the command word, and thus nothing to show
//                subSubString = subString.substring(firstSubStringSpace + 1);//string after the commands ends and after the next space
//            }
//        }
//        if (!askedForNaturalLanguage) {
//            EventBus.getDefault().post(new NaturalLanguageArgsCommandViewRequestEvent(prompt, subSubString));
//            askedForNaturalLanguage = true;
//        } else {
//            EventBus.getDefault().post(new NaturalLanguageArgsCommandViewUpdateRequestEvent(subSubString));
//        }
//    }
//
//    private void foundWakeWord(String wakeWord, int wakeWordEndIdx){
//        //don't run if a wake word has already been found in the current voice buffer
//        if (waked){
//            return;
//        }
//
//        Log.d(TAG, "FOUND WAKE WORD: " + wakeWord);
//
//        //steal focus
//        EventBus.getDefault().post(new AugmentOSStealFocus(true));
//
//        waked = true;
//        this.wakeWordGiven = wakeWord;
//        this.wakeWordEndIdx = wakeWordEndIdx;
//
//        //generate list of each command's top level phrases
//        ArrayList<Object> commandList = new ArrayList();
//        voiceCommands.forEach(voiceCommand -> {
//            commandList.add(voiceCommand.getPhrases().get(0).toLowerCase());
//        });
//
//        //tell ASG that we have found this wake word and to display the following command options
//        String [] commandListSA = commandList.toArray(new String[0]);
//        EventBus.getDefault().post(new PromptViewRequestEvent("Say a command:", commandListSA));
//    }
//
//    private void foundCommand(AugmentOSCommand command, int commandEndIdx, long commandTime){
//        //don't run if a wake word has already been found in the current voice buffer
//        if (commanded){
//            return;
//        }
//        Log.d(TAG, "FOUND COMMAND: " + command.getName());
//
//        commanded = true;
//        this.commandGiven = command;
//        this.commandEndIdx = commandEndIdx;
//        this.commandGivenTime = commandTime;
//    }
//
//    private void runCommand(AugmentOSCommand vc, String preArgs, String wakeWord, String postArgs, long commandTime){
//        //the voice command itself will handle sending the appropriate response to the ASG
//        resetVoiceCommand();
//
//        //drop our stolen focus
////        EventBus.getDefault().post(new AugmentOSStealFocus(false));
//
//        //trigger the command
//        EventBus.getDefault().post(new CommandTriggeredEvent(vc, postArgs, commandTime));
//
//        //we should get a result from TPAs and communicate that
////        if (!result){
////            cancelVoiceCommand();
////        }
//    }
//
//    private void resetVoiceCommand(){
//        Log.d(TAG, "RESET VOICE COMMAND BUFFER FLAGS");
//        waked = false;
//        this.wakeWordGiven = "";
//        commanded = false;
//        this.commandGiven = null;
//        ended = false;
//        gotArg = false;
//        askedForNaturalLanguage = false;
//        haveRequestedArg = false;
//    }
//
//    public void sendResultToAsg(boolean success){
//        EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent("Command Success", "Command Success"));
////        try{
////            //build json object to send command result
////            JSONObject commandResponseObject = new JSONObject();
////            commandResponseObject.put(MessageTypes.MESSAGE_TYPE_LOCAL, MessageTypes.VOICE_COMMAND_STREAM_EVENT);
////            commandResponseObject.put(MessageTypes.VOICE_COMMAND_STREAM_EVENT_TYPE, MessageTypes.RESOLVE_EVENT_TYPE);
////            commandResponseObject.put(MessageTypes.COMMAND_RESULT, success);
////
////            //send the command result
////            dataObservable.onNext(commandResponseObject);
////        } catch (JSONException e){
////            e.printStackTrace();
////        }
//    }
//
//    private void cancelVoiceCommand(){
//        resetVoiceCommand();
//        Log.d(TAG, "CANCEL VOICE COMMAND");
//        EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent("Cancel Voice Command", "Cancelling voice command input."));
//        EventBus.getDefault().post(new AugmentOSStealFocus(false));
//    }
//
//    //helper functions
//    public ArrayList<String> parseKeyValueArgs(String text, String key){
//        ArrayList<String> hits = new ArrayList<String>();
//        int hitLocation = text.indexOf(key);
//
//        if (hitLocation != -1){
//            //find the next spaces
//            int firstSpaceLocation = text.substring(hitLocation).indexOf(" "); //the space after the hit word
//            if (firstSpaceLocation == -1){ //if no space after hit word, then we are at end of string and thus there is no key-value pair
//                return hits;
//            }
//
//            //text after hit
//            String afterText = text.substring(hitLocation + key.length() + 1); //+1 for space after word
//
//            int secondSpaceLocation = afterText.indexOf(" ");
//
//            //word after hit
//            String hit;
//            String restString;
//            if (secondSpaceLocation != -1){
//                hit = afterText.substring(0, secondSpaceLocation);
//                hits.add(hit);
//                restString = afterText.substring(secondSpaceLocation + 1);
//            } else { //if no space, it's the rest of the string
//                hit = afterText;
//                hits.add(hit);
//                return hits;
//            }
//
//            //if more hits, call this function on the rest of the string again
//            int newHitLocation = restString.indexOf(key);
//            if (newHitLocation != -1){
//                hits.addAll(parseKeyValueArgs(restString, key));
//            }
//        }
//
//        return hits;
//    }
//
//    protected String getFirstArg(String toParse){
//        String firstArg = toParse.trim().split("\\s+")[0];
//        return firstArg;
//    }
//
//    public void sendResult(VoiceCommandServer vcServer, boolean success, String commandName, String displayString){
//        if (success) {
//            EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent(commandName + " Succeeded", displayString));
//        } else {
//            EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent(commandName + " Failed", displayString));
//        }
////        try{
////            //build json object to send command result
////            JSONObject commandResponseObject = new JSONObject();
////            commandResponseObject.put(MessageTypes.MESSAGE_TYPE_LOCAL, MessageTypes.VOICE_COMMAND_STREAM_EVENT);
////            commandResponseObject.put(MessageTypes.VOICE_COMMAND_STREAM_EVENT_TYPE, MessageTypes.RESOLVE_EVENT_TYPE);
////            commandResponseObject.put(MessageTypes.COMMAND_RESULT, success);
////            commandResponseObject.put(MessageTypes.COMMAND_NAME, commandName);
////            Log.d(TAG, "DISPLAY STRING: " + displayString);
////            commandResponseObject.put(MessageTypes.COMMAND_RESPONSE_DISPLAY_STRING, displayString);
////            //send the command result
////            vcServer.dataObservable.onNext(commandResponseObject);
////        } catch (JSONException e){
////            e.printStackTrace();
////        }
//    }
//    public void sendMessage(VoiceCommandServer vcServer, String displayString){
//        EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent("sendMessage", displayString));
////        try{
////            //build json object to send command result
////            JSONObject commandResponseObject = new JSONObject();
////            commandResponseObject.put(MessageTypes.MESSAGE_TYPE_LOCAL, MessageTypes.VOICE_COMMAND_RESPONSE);
////            commandResponseObject.put(MessageTypes.COMMAND_RESPONSE_DISPLAY_STRING, displayString);
////            //send the command result
////            vcServer.dataObservable.onNext(commandResponseObject);
////        } catch (JSONException e){
////            e.printStackTrace();
////        }
//    }
//
//    @Subscribe
//    public void onSpeechRecFinalOutputEvent(SpeechRecFinalOutputEvent receivedEvent){
//        Log.d(TAG, "PARSING SPEECH NOW: " + receivedEvent.text);
//        throwHandleNewTranscript(receivedEvent.text, receivedEvent.timestamp, true);
//    }
//
//    @Subscribe
//    public void onSpeechRecIntermediateOutputEvent(SpeechRecIntermediateOutputEvent receivedEvent){
//        throwHandleNewTranscript(receivedEvent.text, receivedEvent.timestamp, false);
//    }
//
//    private void throwHandleNewTranscript(String transcript, long timestamp, boolean isFinal){
//        //run on new thread so we don't slow anything down
//        vcHandler.post(new Runnable() {
//            public void run() {
//                handleNewTranscript(transcript, timestamp, isFinal);
//            }
//        });
//    }
//
//    public void destroy(){
//        EventBus.getDefault().unregister(this);
//    }
//
//}
