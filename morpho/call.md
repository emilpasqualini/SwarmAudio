very bad performance. can you check what the problem is? is it running properly multicore? i would like to delegate most things to the gpu where possible

also adapt the amount of voices in the synth tab, to the actual amount of clients connected, there seems to be a lot of stale voices... make sure the mapping of uid -> synth is intuitive.

lastly, consider all slots as equal! the model level should only be modulated by the camera in the respective model's section (1 through 4)

lastly give me a list of parameters that are relevant for receiving. such that we can reduce the packets sent by the server.

Also. NEW ADDITIONAL MODE: every client has a synth, the queen's goes into her own model, everyone else's goes into a different one. this updates when the queen changes! (the goal is finding out who the queen is by sound!) make sure the levels between queen and the rest are relatively equal.


ANOTHER ANOTHER NEW MODE: we have n model slots, n being the amount of clients that are connected, random models are loaded at start and more loaded adaptively. each clients synth feeds a model. maybe additionally figure out how the model parameters can be controlled by the client in this case. the queens model still has precedence in this scenario.