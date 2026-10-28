#include "control_schedule.h"
#include <assert.h>
#include <stdio.h>
int main(void)
{
    assert(cp_control_next(0,false,false,false,0,0,0)==CP_CONTROL_CONTACT);
    assert(cp_control_next(100,true,false,true,0,0,0)==CP_CONTROL_POLICY);
    assert(cp_control_next(100,true,false,true,0,200,0)==CP_CONTROL_CONTACT);
    assert(cp_control_next(100,true,false,true,200,200,0)==CP_CONTROL_ACTIVATION);
    assert(cp_control_next(100,true,false,false,200,200,0)==CP_CONTROL_NONE);
    assert(cp_control_next(100,true,true,true,200,0,0)==CP_CONTROL_NONE);
    assert(cp_control_next(100,false,false,true,200,0,0)==CP_CONTROL_NONE);
    /* Slow contact completion must be followed by policy before old backlog;
     * policy's next deadline is independent from contact's completed deadline. */
    uint64_t now=10000,contact_at=40000,policy_at=0;
    assert(cp_control_next(now,true,false,false,contact_at,policy_at,0)==CP_CONTROL_POLICY);
    now+=12000;policy_at=now+30000;
    assert(cp_control_next(now,true,false,false,contact_at,policy_at,0)==CP_CONTROL_NONE);
    puts("control scheduling: startup policy priority, candidate isolation, one operation passed");
}
